import type { HtmlPluginOptions, UrlTransformerFunction } from './types'
import { Base } from './Base'
import { buildHistoryApiFallback } from '../history-api/historyApiFallbackPlugin'
import type { ViteDevServer } from 'vite'
import type { HistoryApiOptions, HistoryRewrites } from '../history-api/types'
import { normalizePath } from './utils'

export class Serve extends Base {
  _rewrites?: Array<HistoryRewrites>
  
  _urlTransformer?: UrlTransformerFunction
  
  constructor(virtualHtmlOptions: HtmlPluginOptions & HistoryApiOptions) {
    super(virtualHtmlOptions)
    this._rewrites = virtualHtmlOptions.rewrites
    this._urlTransformer = virtualHtmlOptions.urlTransformer
  }
  
  _configureServer = (server: ViteDevServer) => {
    if (this._rewrites) {
      buildHistoryApiFallback(server, this._rewrites)
    }
    // other html handled after vite's inner middlewares.
    return () => {
      server.middlewares.use('/', async (req, res, next) => {
        const originalUrl = req.originalUrl
        const reqUrl = req.url
        let url = decodeURI(this.generateUrl(originalUrl?.endsWith('/') ? originalUrl : reqUrl))
        if (this._urlTransformer) {
          url = this._urlTransformer(url, req)
        }
        // if request is not html , directly return next()
        if ((!url.endsWith('.html') && !url.endsWith('/')) && url !== '/') {
          return next()
        }
        // request / means client requests an index page
        // load it with indexPage config
        let htmlCode: string
        if (url === '/' || url === '/index.html') {
          url = `/${this._indexPage}.html`
        }
        // load specify html file code
        htmlCode = await this._load(normalizePath(url)) ?? ''
        const transformResult = await this._transform(htmlCode, url)
        if (transformResult === null) {
          return next()
        }
        res.end(await server.transformIndexHtml(url, transformResult))
        next()
      })
    }
  }
}
