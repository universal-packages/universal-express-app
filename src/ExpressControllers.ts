import { EventEmitter } from '@universal-packages/event-emitter'
import { ModuleRegistry, loadModules } from '@universal-packages/module-loader'
import { ClassRegistry, ClassType, Decoration, MethodRegistry, NamespaceRegistry, getNamespace } from '@universal-packages/namespaced-decorators'
import { startMeasurement } from '@universal-packages/time-measurer'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { Express, NextFunction, Request, RequestHandler, Response } from 'express'
import getPort from 'get-port'
import helmet from 'helmet'
import http from 'http'
import { StatusCodes } from 'http-status-codes'

import { ActionDecoration } from './Action.types'
import { ActionUseDecoration } from './ActionUse.types'
import { ArgumentDecoration } from './Argument.types'
import BaseMiddleware from './BaseMiddleware'
import { ControllerDecoration } from './Controller.types'
import { ControllerUseDecoration } from './ControllerUse.types'
import { BodyParser, ExpressControllersOptions, MiddlewareLike, RequestContext } from './ExpressControllers.types'
import { MiddlewareDecoration } from './Middleware.types'
import { NAMESPACE } from './namespace'

export default class ExpressControllers extends EventEmitter {
  public readonly options: ExpressControllersOptions
  public readonly expressInstance: Express
  public readonly httpServer: http.Server

  private namespaceRegistry: NamespaceRegistry
  private controllerModules: ModuleRegistry[]
  private middlewareModules: ModuleRegistry[]
  private allModules: ModuleRegistry[]

  private eachMiddleware: { middleware: MiddlewareLike; methodRegistry: MethodRegistry }[] = []

  public constructor(options: ExpressControllersOptions) {
    super()
    this.options = { appLocation: './src', ...options }
    this.expressInstance = express()
    this.httpServer = http.createServer(this.expressInstance)
  }

  public async prepare(): Promise<void> {
    await this.applyPreMiddleware()
    await this.loadNamespaceRegistry()
    await this.loadMiddleware()
    await this.loadControllers()
    await this.applyPostMiddleware()
  }

  public async run(): Promise<void> {
    return new Promise(async (resolve, reject): Promise<void> => {
      const finalPort = this.options.port || (await getPort({ port: getPort.makeRange(3000, 3100) }))
      this.httpServer.on('error', reject)
      this.httpServer.listen({ ...this.options, port: finalPort }, resolve)
    })
  }

  public async stop(): Promise<void> {
    return new Promise(async (resolve, reject): Promise<void> => {
      this.httpServer.close((error: Error): void => {
        if (error) return reject(error)
        resolve()
      })
    })
  }

  private async applyPreMiddleware(): Promise<void> {
    this.expressInstance.use((request: Request, _: Response, next: NextFunction): void => {
      const requestMeasurer = startMeasurement()
      request['requestContext'] = { requestMeasurer } as RequestContext

      this.emit('request:start', { payload: { request } })
      next()
    })

    if (this.options.helmet) this.expressInstance.use(helmet(this.options.helmet === true ? {} : this.options.helmet))
    if (this.options.cors) this.expressInstance.use(cors(this.options.cors === true ? {} : this.options.cors))
    if (this.options.cookieParser)
      this.expressInstance.use(
        cookieParser(
          this.options.cookieParser === true ? undefined : this.options.cookieParser.secret,
          this.options.cookieParser === true ? undefined : this.options.cookieParser.options
        )
      )
    if (this.options.viewEngine) this.expressInstance.set('view engine', this.options.viewEngine)
  }

  private async applyPostMiddleware(): Promise<void> {
    this.expressInstance.use((request: Request, response: Response, next: NextFunction): void => {
      const requestContext = request['requestContext'] as RequestContext
      response.statusCode = StatusCodes.NOT_FOUND

      this.emit('request:not-found', { measurement: requestContext.requestMeasurer.finish(), payload: { request, response } })
      response.end()
    })

    this.expressInstance.use((error: Error, request: Request, response: Response, _next: NextFunction): void => {
      const requestContext = request['requestContext'] as RequestContext
      response.status(StatusCodes.INTERNAL_SERVER_ERROR)

      this.emit('request:error', { error, measurement: requestContext.requestMeasurer.finish(), payload: { request, response } })

      response.end()
    })
  }

  private async loadNamespaceRegistry(): Promise<void> {
    const thirdPartyMiddlewareModules = await loadModules('./node_modules', { conventionPrefix: 'universal-express-middleware' })
    const middlewareModules = await loadModules(this.options.appLocation, { conventionPrefix: 'middleware' })
    this.middlewareModules = [...thirdPartyMiddlewareModules, ...middlewareModules]

    const thirdPartyControllerModules = await loadModules('./node_modules', { conventionPrefix: 'universal-express-controller' })
    const controllerModules = await loadModules(this.options.appLocation, { conventionPrefix: 'controller' })
    this.controllerModules = [...thirdPartyControllerModules, ...controllerModules]

    this.allModules = [...this.middlewareModules, ...this.controllerModules]

    const erroredModule = this.allModules.find((module: ModuleRegistry): boolean => !!module.error)
    if (erroredModule) {
      if (erroredModule.error instanceof Error) {
        throw erroredModule.error
      } else {
        throw new Error(erroredModule.error as any)
      }
    }

    const noDefaultExportModule = this.allModules.find((module: ModuleRegistry): boolean => !module.exports)
    if (noDefaultExportModule) throw new Error(`No default export for module\n${noDefaultExportModule.location}`)

    this.namespaceRegistry = await getNamespace(NAMESPACE, this.allModules)
  }

  private async loadMiddleware(): Promise<void> {
    // No controllers have been found
    if (!this.namespaceRegistry) return

    const middlewareClassRegistries = this.namespaceRegistry.classes.filter(
      (classRegistry: ClassRegistry): boolean => !!classRegistry.decorations.find((decoration: MiddlewareDecoration): boolean => decoration.__type === 'middleware')
    )

    const pathMiddleware: { middleware: typeof BaseMiddleware; methodRegistry: MethodRegistry; path: string }[] = []

    for (let i = 0; i < this.middlewareModules.length; i++) {
      const currentModule = this.middlewareModules[i]
      const middlewareClassRegistry = middlewareClassRegistries.find((registry: ClassRegistry): boolean => registry.target === currentModule.exports)
      const middlewareMethodRegistry = middlewareClassRegistry?.methods.find((methodRegistry: MethodRegistry): boolean => methodRegistry.propertyKey === 'middleware')
      const middlewareClassDecoration = middlewareClassRegistry?.decorations.find((decoration: MiddlewareDecoration): boolean => decoration.__type === 'middleware') as
        | MiddlewareDecoration
        | undefined

      if (middlewareClassDecoration?.path) {
        pathMiddleware.push({ middleware: currentModule.exports, methodRegistry: middlewareMethodRegistry, path: middlewareClassDecoration.path })
      } else {
        // We preserve middle ware that needs to be used per route handler
        if (middlewareClassDecoration?.options?.strategy === 'each') {
          this.eachMiddleware.push({ middleware: currentModule.exports, methodRegistry: middlewareMethodRegistry })
        } else {
          this.expressInstance.use(this.generateMiddlewareHandler(currentModule.exports, {}, middlewareMethodRegistry))
        }
      }
    }

    // We set middleware that has its own path to be applied to
    for (let i = 0; i < pathMiddleware.length; i++) {
      const currentPathMiddleware = pathMiddleware[i]
      const finalPath = `/${currentPathMiddleware.path}`.replace(/\/+/g, '/').replace(/(.+)\/$/, '$1')
      this.expressInstance.use(finalPath, this.generateMiddlewareHandler(currentPathMiddleware.middleware, {}, currentPathMiddleware.methodRegistry))
    }
  }

  private async loadControllers(): Promise<void> {
    if (this.namespaceRegistry) {
      /// Edge cases -------------------------------
      const notRegisteredClass = this.namespaceRegistry.classes.find(
        (classRegistry: ClassRegistry): boolean =>
          classRegistry.decorations.filter((decoration: Decoration): boolean => decoration.__type === 'controller' || decoration.__type === 'middleware').length === 0
      )
      if (notRegisteredClass)
        throw new Error(`Class ${notRegisteredClass.name} make use of decorators but hasn't been registered with @Controller or @Middleware\n${notRegisteredClass.location}`)

      const doubleRegisteredClass = this.namespaceRegistry.classes.find((classRegistry: ClassRegistry): boolean => {
        return classRegistry.decorations.filter((decoration: Decoration): boolean => decoration.__type === 'controller' || decoration.__type === 'middleware').length > 1
      })
      if (doubleRegisteredClass)
        throw new Error(`Class ${doubleRegisteredClass.name} class has been registered with multiple @Controller and/or @Middleware what?\n${doubleRegisteredClass.location}`)
      /// Edge cases -------------------------------

      const middlewareClassRegistries = this.namespaceRegistry.classes.filter(
        (classRegistry: ClassRegistry): boolean => !!classRegistry.decorations.find((decoration: MiddlewareDecoration): boolean => decoration.__type === 'middleware')
      )

      const controllerClassesRegistries = this.namespaceRegistry.classes.filter(
        (classRegistry: ClassRegistry): boolean => !!classRegistry.decorations.find((decoration: ControllerDecoration): boolean => decoration.__type === 'controller')
      )

      for (let i = 0; i < controllerClassesRegistries.length; i++) {
        const currentClassRegistry = controllerClassesRegistries[i]
        const controllerDecoration = currentClassRegistry.decorations.find(
          (decoration: ControllerDecoration): boolean => decoration.__type === 'controller'
        ) as ControllerDecoration
        const controllerUseDecorations = currentClassRegistry.decorations.filter(
          (decoration: ControllerUseDecoration): boolean => decoration.__type === 'controller-use'
        ) as ControllerUseDecoration[]
        const controllerHandlers: RequestHandler[] = []
        const controllerRoute = `/${controllerDecoration.path || ''}`.replace(/\/+/g, '/').replace(/(.+)\/$/, '$1')

        // Apply whole router level middleware
        for (let j = 0; j < controllerUseDecorations.length; j++) {
          const currentControllerUseDecoration = controllerUseDecorations[j]
          const middlewareClassRegistry = middlewareClassRegistries.find((registry: ClassRegistry): boolean => registry.target === currentControllerUseDecoration.middleware)
          const middlewareMethodRegistry = middlewareClassRegistry?.methods.find((methodRegistry: MethodRegistry): boolean => methodRegistry.propertyKey === 'middleware')

          controllerHandlers.push(this.generateMiddlewareHandler(currentControllerUseDecoration.middleware, currentControllerUseDecoration.options, middlewareMethodRegistry))
        }

        for (let j = 0; j < currentClassRegistry.methods.length; j++) {
          const currentMethodRegistry = currentClassRegistry.methods[j]
          const actionDecoration = currentMethodRegistry.decorations.find((decoration: ActionDecoration): boolean => decoration.__type === 'action') as ActionDecoration
          const actionUseDecorations = currentMethodRegistry.decorations.filter(
            (decoration: ActionUseDecoration): boolean => decoration.__type === 'action-use'
          ) as ActionUseDecoration[]

          const route = `/${actionDecoration.path || ''}`.replace(/\/+/g, '/').replace(/(.+)\/$/, '$1')
          const actionHandlers: RequestHandler[] = []

          // Just before the action and middleware process the request the body parser will parse the body for this particular request
          const actionDecorationBodyParser = actionDecoration.options?.bodyParser === 'none' ? undefined : actionDecoration.options?.bodyParser
          const controllerDecorationBodyParser = controllerDecoration.options?.bodyParser === 'none' ? undefined : controllerDecoration.options?.bodyParser
          const bodyParsers = [].concat(actionDecorationBodyParser || controllerDecorationBodyParser || this.options.bodyParser).filter(Boolean)
          const finalBodyParsers = bodyParsers.map((parser: BodyParser): RequestHandler => express[parser]())
          actionHandlers.push(...finalBodyParsers)

          // We set the global middleware configured to run for each action handler and not globally
          for (let k = 0; k < this.eachMiddleware.length; k++) {
            const currentEachMiddleware = this.eachMiddleware[k]

            actionHandlers.push(this.generateMiddlewareHandler(currentEachMiddleware.middleware, {}, currentEachMiddleware.methodRegistry))
          }

          // We prepare all middleware handlers that will process request before this particular action
          for (let k = 0; k < actionUseDecorations.length; k++) {
            const currentActionUseDecorations = actionUseDecorations[k]
            const middlewareClassRegistry = middlewareClassRegistries.find((registry: ClassRegistry): boolean => registry.target === currentActionUseDecorations.middleware)
            const middlewareMethodRegistry = middlewareClassRegistry?.methods.find((methodRegistry: MethodRegistry): boolean => methodRegistry.propertyKey === 'middleware')

            actionHandlers.push(this.generateMiddlewareHandler(currentActionUseDecorations.middleware, currentActionUseDecorations.options, middlewareMethodRegistry))
          }

          // And now the last is the actual action handler
          actionHandlers.push(this.generateActionHandler(currentMethodRegistry, currentClassRegistry.target))

          // Join controller and action routes for a final route, apply all controller and action middleware
          this.expressInstance[actionDecoration.method.toLocaleLowerCase()](`${controllerRoute}${route}`, [...controllerHandlers, ...actionHandlers])
        }
      }
    } else {
      this.emit('warning', { message: 'No controllers have been found' })
    }
  }

  private generateMiddlewareHandler(middleware: MiddlewareLike, options?: Record<string, any>, middlewareMethodRegistry?: MethodRegistry): RequestHandler {
    if (/^\s*class\s+/.test(middleware.toString())) {
      return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
        this.emit('request:middleware', { payload: { name: middleware.name } })

        try {
          const middlewareInstance = new (middleware as typeof BaseMiddleware)(request, response, options)
          const args = middlewareMethodRegistry ? this.generateActionArgs(middlewareMethodRegistry, request, response, options) : []

          await middlewareInstance.middleware(...args)

          if (response.writableEnded) {
            const requestContext = request['requestContext'] as RequestContext

            this.emit('request:end', { measurement: requestContext.requestMeasurer.finish(), payload: { handler: middleware.name, request, response } })
          } else {
            next()
          }
        } catch (error) {
          next(error)
        }
      }
    } else {
      return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
        try {
          const functionName = /function\s+([\w\$]+)\s*\(/.exec(middleware.toString())

          this.emit('request:middleware', { payload: { name: functionName ? functionName[1] : 'anonymous' } })

          await (middleware as RequestHandler)(request, response, next)
        } catch (error) {
          next(error)
        }
      }
    }
  }

  private generateActionHandler(methodRegistry: MethodRegistry, target: ClassType): RequestHandler {
    return async (request: Request, response: Response, next: NextFunction): Promise<any> => {
      const requestContext = request['requestContext'] as RequestContext
      try {
        const handler = `${target.name}#${methodRegistry.propertyKey}`
        request['requestContext']['handler'] = handler

        this.emit('request:handler', { payload: { handler, request } })

        const controllerInstance = new target(request, response)
        const args = this.generateActionArgs(methodRegistry, request, response)

        await controllerInstance[methodRegistry.propertyKey](...args)

        response.end()

        this.emit('request:end', { measurement: requestContext.requestMeasurer.finish(), payload: { handler, request, response } })
      } catch (error) {
        next(error)
      }
    }
  }

  private generateActionArgs(methodRegistry: MethodRegistry, request: Request, response: Response, middlewareOptions?: any): any[] {
    const numberOfArguments = methodRegistry.arguments[0] ? methodRegistry.arguments[0].index + 1 : 0

    const finalArgs = new Array(numberOfArguments)

    for (let i = 0; i < methodRegistry.arguments.length; i++) {
      const currentArgumentRegistry = methodRegistry.arguments[i]
      const decoration = currentArgumentRegistry.decorations[0] as ArgumentDecoration

      switch (decoration.__type) {
        case 'body':
          finalArgs[currentArgumentRegistry.index] = request.body
          break
        case 'header':
          finalArgs[currentArgumentRegistry.index] = request.header(decoration.property)
          break
        case 'headers':
          finalArgs[currentArgumentRegistry.index] = request.headers
          break
        case 'param':
          finalArgs[currentArgumentRegistry.index] = request.params[decoration.property]
          break
        case 'params':
          finalArgs[currentArgumentRegistry.index] = request.params
          break
        case 'query':
          if (decoration.property) {
            finalArgs[currentArgumentRegistry.index] = request.query[decoration.property]
          } else {
            finalArgs[currentArgumentRegistry.index] = request.query
          }
          break
        case 'req':
          if (decoration.property) {
            finalArgs[currentArgumentRegistry.index] = request[decoration.property]
          } else {
            finalArgs[currentArgumentRegistry.index] = request
          }
          break
        case 'res':
          finalArgs[currentArgumentRegistry.index] = response
          break
        case 'middleware-options':
          finalArgs[currentArgumentRegistry.index] = middlewareOptions
      }
    }

    return finalArgs
  }
}
