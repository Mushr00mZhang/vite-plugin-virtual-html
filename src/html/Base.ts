import type { HtmlPluginOptions, InjectCode, PageObject, VirtualHtmlTemplateData } from './types'
import { Pages, POS, VirtualHtmlPage, VirtualHtmlTemplateRender, VirtualPageOptions } from './types'
import { type UserConfig, createFilter, } from 'vite'
import * as path from 'path'
import * as fs from 'fs'
import { normalizePath, } from './utils'
import glob from 'fast-glob'
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
  logger = debug('vite-plugin-virtual-html')
  _filter: (id: string | unknown) => boolean
  
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
    this._filter = createFilter(/\.html|\/$/,)
  }
  
  /**
   * load html file
   * @param id
   */
  _load = async (id: string) => {
    if (this._filter(id)) {
      let newId = this.getHtmlName(id, this._config?.root)
      const maybeIndexName1 = (newId+'/').replace('//', '/')
      const maybeIndexName2 = (newId + '/index').replace('//', '/')
      const maybeIndexName3 = newId.replace('index', '').replace('//', '/')
      
      const pageOption: VirtualHtmlPage | VirtualPageOptions = this._pages[newId] || this._pages[maybeIndexName1] || this._pages[maybeIndexName2] || this._pages[maybeIndexName3]
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
  _transform = async (code: string, id: string): Promise<string | null> => {
    if (this._filter(id)) {
      const ids = id.split('/')
      const key = ids[ids.length - 1]
      let _code = code
      if (DEFAULT_INJECTCODE_ALL in this._injectCode) {
        _code = this.generateInjectCode(this._injectCode[DEFAULT_INJECTCODE_ALL], code)
      }
      if (key in this._injectCode) {
        _code = this.generateInjectCode(this._injectCode[key], code)
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
  getHtmlName = (id: string, root?: string) => {
    const _root = (root ?? '').replace(this.cwd, '')
    const _id = id.replace(this.cwd, '')
    const result = _id.replace('.html','').replace(_root !== '' ? this.addTrailingSlash(_root) : '', '')
    return result.startsWith('/') ? result.substring(1,result.length) : result
  }
  
  /**
   * add trailing slash on path
   * @param {string} path
   * @returns {string}
   */
  addTrailingSlash = (path: string): string => {
    const _path = normalizePath(path.replace(this.cwd, ''))
    return _path.endsWith('/') ? _path : `${_path}/`
  }
  
  /**
   * generate URL
   * @param url
   */
  generateUrl = (url?: string): string => {
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
  readHtml = async ({
                      template = '',
                      data = {},
                      render = this.defaultRender
                    }: PageObject) => {
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
  renderTemplate = async (templatePath: string, render: VirtualHtmlTemplateRender, data: VirtualHtmlTemplateData) => {
    return await this.readTemplate(templatePath).then(code => {
      return render(code, data)
    })
  }
  
  /**
   * read html file's content to render with render function
   * @param templatePath
   */
  readTemplate = async (templatePath: string): Promise<string> => {
    const result = await fsp.readFile(templatePath)
    return result.toString()
  }
  
  /**
   * generate page option from string/object to object
   * @param page
   * @param globalData
   * @param globalRender
   */
  generatePageOptions = async (page: PageObject | string, globalData: Record<string, unknown>, globalRender: VirtualHtmlTemplateRender): Promise<PageObject> => {
    if (typeof page === 'string') {
      return {
        template: page,
        data: {
          ...globalData,
        },
        render: globalRender,
      }
    }
    const {
      data = {},
      render,
      template
    } = page
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
  generateInjectCode = ({
                          pos,
                          find,
                          replacement
                        }: InjectCode, code: string): string => {
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
  generateVirtualPage = async (vPages: VirtualPageOptions): Promise<string> => {
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
  findAllHtmlInProject = (extraGlobPattern: Array<string> = []): Pages => {
    const pages: Pages = {}
    let realPattern: Array<string> = []
    if (extraGlobPattern.length === 0) {
      realPattern = DEFAULT_GLOB_PATTERN
    } else {
      const set: Set<string> = new Set()
      DEFAULT_GLOB_PATTERN.forEach(dg=>set.add(dg))
      extraGlobPattern.forEach(dg=>set.add(dg))
      for (let key of set.keys()) {
        realPattern.push(key)
      }
    }
    const files = glob.sync(realPattern)
    files.forEach(file => {
      const filePathArr = file.split('/')
      pages[filePathArr[filePathArr.length - 1].replace('.html', '')] = `/${file}`
    })
    return pages
  }
  
  defaultRender = (template: string, data: Record<string, any>) => {
    try {
      const resolved = require.resolve('ejs')
      return require(resolved).render(template, data, {
        delimiter: '%',
        root: process.cwd()
      })
    } catch (e) {
      //
    }
    return template
  }
}
