import type {HtmlPluginOptions, InjectCode, PageObject, VirtualHtmlTemplateData} from "./types"
import {Pages, POS, VirtualHtmlPage, VirtualHtmlTemplateRender, VirtualPageOptions} from "./types"
import type {UserConfig} from 'vite'
import * as path from 'path'
import * as fs from 'fs'
import {normalizePath,} from "./utils"
import glob from "fast-glob"
import debug from 'debug'

const fsp = fs.promises
const DEFAULT_GLOB_PATTERN = [
  '**/*.html',
  '!node_modules/**/*.html',
  '!.**/*.html'
]
const VIRTUAL_HTML_CONTENT = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>#TITLE#</title>
    <script src="#ENTRY#" type="module"></script>
</head>
<body>
#BODY#
</body>
</html>
`
export const DEFAULT_INJECTCODE_ALL = '*'

export class Base {
  _config?: UserConfig

  _pages: Pages

  _indexPage: string

  _globalRender: VirtualHtmlTemplateRender

  _globalData: Record<string, unknown>

  _injectCode: Record<string, InjectCode>

  cwd = normalizePath(process.cwd())
  alreadyShowEjsError = false
  logger = debug('vite-plugin-virtual-html')

  constructor(virtualHtmlOptions: HtmlPluginOptions) {
    const {
      pages: pagesObj,
      indexPage = 'index',
      render = this.defaultRender,
      data = {},
      extraGlobPattern = [],
      injectCode = {},
    } = virtualHtmlOptions
    if (pagesObj === true || pagesObj === undefined) {
      this._pages = this.findAllHtmlInProject(extraGlobPattern)
    } else {
      this._pages = pagesObj
    }
    this._indexPage = indexPage
    this._globalData = data
    this._globalRender = render
    this._injectCode = injectCode
  }

  /**
   * load html file
   * @param id
   */
  async _load(id: string) {
    if (id.endsWith('html')) {
      const newId = this.getHtmlName(id, this._config?.root)
      const pageOption: VirtualHtmlPage | VirtualPageOptions = this._pages[newId]
      if (pageOption !== undefined) {
        // string
        if (typeof pageOption === 'string') {
          const page = await this.generatePageOptions(pageOption, this._globalData, this._globalRender)
          // generate html template
          return await this.readHtml(page)
        }
        // PageObject
        if ('template' in pageOption) {
          const page = await this.generatePageOptions(pageOption, this._globalData, this._globalRender)
          // generate html template
          return await this.readHtml(page)
        }
        // VirtualPageOptions
        if ('entry' in pageOption) {
          return await this.generateVirtualPage(pageOption)
        }
      }
    }
    return null
  }

  /**
   * transform code to inject some code into original code
   * @param code
   * @param id
   */
  async _transform(code: string, id: string): Promise<string | null> {
    if (id.indexOf('.html') >= 0) {
      const ids = id.split('/')
      const key = ids[ids.length - 1]
      let _code = code
      if (key in this._injectCode) {
        _code = this.generateInjectCode(this._injectCode[key], code)
      }
      if (DEFAULT_INJECTCODE_ALL in this._injectCode) {
        _code = this.generateInjectCode(this._injectCode[DEFAULT_INJECTCODE_ALL], code)
      }
      return _code
    }
    return null
  }

  /**
   * get html file's name
   * @param id
   * @param root
   */
  getHtmlName(id: string, root?: string) {
    const _root = (root ?? '').replace(this.cwd, '')
    const _id = id.replace(this.cwd, '')
    const result = _id.substring(0, _id.length - '.html'.length).replace(_root !== '' ? this.addTrailingSlash(_root) : '', '')
    return result.startsWith('/') ? result.substring(1) : result
  }

  /**
   * add trailing slash on path
   * @param {string} path
   * @returns {string}
   */
  addTrailingSlash(path: string): string {
    const _path = normalizePath(path.replace(this.cwd, ''))
    return _path.endsWith('/') ? _path : `${_path}/`
  }

  /**
   * generate URL
   * @param url
   */
  generateUrl(url?: string): string {
    if (!url) {
      return '/'
    }
    // url with parameters
    if (url.indexOf('?') > 0) {
      return url.split('?')[0]
    }
    return url
  }

  /**
   * read HTML file from disk and generate code from template system(with render function)
   * @param template
   * @param data
   * @param render
   */
  async readHtml({template = '', data = {}, render = this.defaultRender}: PageObject) {
    const templatePath = path.resolve(this.cwd, `.${template}`)
    if (!fs.existsSync(templatePath)) {
      this.logger('[vite-plugin-virtual-html]: template file must exist!')
      return ''
    }
    return await this.renderTemplate(templatePath, render, data)
  }

  /**
   * render template
   * @param templatePath
   * @param render
   * @param data
   */
  async renderTemplate(templatePath: string, render: VirtualHtmlTemplateRender, data: VirtualHtmlTemplateData) {
    return await this.readTemplate(templatePath).then(code => {
      return render(code, data)
    })
  }

  /**
   * read html file's content to render with render function
   * @param templatePath
   */
  async readTemplate(templatePath: string): Promise<string> {
    const result = await fsp.readFile(templatePath)
    return result.toString()
  }

  /**
   * generate page option from string/object to object
   * @param page
   * @param globalData
   * @param globalRender
   */
  async generatePageOptions(page: PageObject | string, globalData: Record<string, unknown>, globalRender: VirtualHtmlTemplateRender): Promise<PageObject> {
    if (typeof page === 'string') {
      return {
        template: page,
        data: {
          ...globalData,
        },
        render: globalRender,
      }
    }
    // todo
    const {data = {}, render, template} = page
    return {
      template: template,
      data: {
        ...globalData,
        ...data,
      },
      render: render ?? globalRender ?? this.defaultRender,
    }
  }

  /**
   * directly use find\replacement / replacement\find to replace find
   * @param {pos, find, replacement}
   * @param code
   */
  generateInjectCode({pos, find, replacement}: InjectCode, code: string): string {
    if (pos === POS.after) {
      return code.replace(find, `${find}\n${replacement}`)
    }
    if (pos === POS.before) {
      return code.replace(find, `\n${replacement}\n${find}`)
    }
    return code
  }

  /**
   * generate page from virtual page
   * @param vPages
   */
  async generateVirtualPage(vPages: VirtualPageOptions): Promise<string> {
    const {
      entry,
      title = '',
      body = '<div id="app"></div>'
    } = vPages
    return VIRTUAL_HTML_CONTENT.replace('#ENTRY#', entry).replace('#TITLE#', title).replace('#BODY#', body)
  }

  /**
   * find all html file in project and return it as Pages
   */
  findAllHtmlInProject(extraGlobPattern: Array<string> = []): Pages {
    const pages: Pages = {}
    let realPattern = extraGlobPattern
    if (extraGlobPattern.length === 0) {
      realPattern = DEFAULT_GLOB_PATTERN
    }
    const files = glob.sync(realPattern)
    files.forEach(file => {
      const filePathArr = file.split('/')
      pages[filePathArr[filePathArr.length - 1].replace('.html', '')] = `/${file}`
    })
    return pages
  }

  defaultRender(template: string, data: Record<string, any>) {
    try {
      const resolved = require.resolve('ejs')
      return require(resolved).render(template, data, {
        delimiter: '%',
        root: process.cwd()
      })
    } catch (e) {
      // @ts-ignore
      if (e.code === 'MODULE_NOT_FOUND') {
        if (!this.alreadyShowEjsError) {
          this.logger(`[vite-plugin-virtual-html]: Module 'ejs' is not found! If you want to use it, please install it. Otherwise please ignore this error!`)
          this.alreadyShowEjsError = true
        }
      }
    }
    return template
  }
}