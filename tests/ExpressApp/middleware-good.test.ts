import { ExpressApp } from '../../src'

const port = 4000 + Number(process.env['JEST_WORKER_ID'])

let app: ExpressApp
afterEach(async (): Promise<void> => {
  await app.stop()
})

describe(ExpressApp, (): void => {
  it('It executed configured middleware all across controllers', async (): Promise<void> => {
    const eventListener = jest.fn()
    app = new ExpressApp({ appLocation: './tests/__fixtures__/middleware-good', port })
    await app.prepare()
    await app.run()

    app.on('request/start', eventListener)
    app.on('request/end', eventListener)
    app.on('request/middleware', eventListener)
    app.on('request/not-found', eventListener)
    app.on('request/error', console.log)

    await fGet('good/69')
    expect(fResponse).toHaveReturnedWithStatus('OK')
    expect(fResponseBody).toEqual([
      { excellentMiddleware: true },
      { goodMiddleware: true },
      { controllerMiddlewareB: true, options: { middle: 'c-b' } },
      { controllerMiddlewareA: true, options: { middle: 'c-a' } },
      { eachMiddleware: true, params: { id: '69' } },
      { actionMiddlewareB: true, options: { middle: 'a-b' } },
      { actionMiddlewareA: true, options: { middle: 'a-a' } }
    ])

    expect(eventListener.mock.calls).toMatchObject([
      [{ event: 'request/start' }],
      [{ event: 'request/middleware', payload: { name: 'excellent' } }],
      [{ event: 'request/middleware', payload: { name: 'good' } }],
      [{ event: 'request/middleware', payload: { name: 'ControllerMiddlewareB' } }],
      [{ event: 'request/middleware', payload: { name: 'ControllerMiddlewareA' } }],
      [{ event: 'request/middleware', payload: { name: 'EachMiddleware' } }],
      [{ event: 'request/middleware', payload: { name: 'ActionMiddlewareB' } }],
      [{ event: 'request/middleware', payload: { name: 'ActionMiddlewareA' } }],
      [{ event: 'request/end', payload: { handler: 'GoodController#getEnd' } }]
    ])
  })
})
