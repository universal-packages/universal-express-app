import { ExpressApp } from '../../src'

const port = 4000 + Number(process.env['JEST_WORKER_ID'])

let app: ExpressApp
afterEach(async (): Promise<void> => {
  await app.stop()
})

describe(ExpressApp, (): void => {
  it('It catches any action error and fails the request', async (): Promise<void> => {
    const eventListener = jest.fn()
    app = new ExpressApp({ appLocation: './tests/__fixtures__/controller-action-error', port })
    await app.prepare()
    await app.run()

    app.on('request/start', eventListener)
    app.on('request/end', eventListener)
    app.on('request/middleware', eventListener)
    app.on('request/error', eventListener)

    await fGet('bad')
    expect(fResponse).toHaveReturnedWithStatus('INTERNAL_SERVER_ERROR')

    expect(eventListener.mock.calls).toMatchObject([[{ event: 'request/start' }], [{ event: 'request/error', error: new Error('Bad request') }]])
  })
})
