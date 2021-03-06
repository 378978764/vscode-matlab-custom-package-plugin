import { readContent } from "./utils/reader"
import TextUtils from "./utils/TextUtils"

const path = require("path")
const fs = require("fs")

type StructCompletion = {
  name: string,
  members: string[]
}

type FunctionCall = {
  name: string,
  params: string[],
  returns: string[]
}

/**
 * Match and return dir paths in `addpath` command
 * @param {string} str current document content
 */
function matchAddPath(str: string) {
  let addPaths: Array<string> = []
  const regex = /^(?!\%)addpath\(["'](\S+)["']\)/gm
  let m: RegExpExecArray | null
  while ((m = regex.exec(str)) !== null) {
    // This is necessary to avoid infinite loops with zero-width matches
    if (m.index === regex.lastIndex) {
      regex.lastIndex++
    }

    // The result can be accessed through the `m`-variable.
    m.forEach(() => {
      m && addPaths.push(m[1])
    })
  }
  return addPaths
}

/**
 * Get quick suggestions like ones provided by vscode
 * for the reason that custom completion will overwrite original quick subbestions.
 * @param {string}} content current file's content
 */
function getCurrentFileVariables(content: string): Array<string> {
  // Case 1: variableName = xxx
  // Case 2: at function line
  const regex = /\b([\w_]+)\b/gm
  let m
  let res = new Set()

  while ((m = regex.exec(content)) !== null) {
    // This is necessary to avoid infinite loops with zero-width matches
    if (m.index === regex.lastIndex) {
      regex.lastIndex++
    }

    // The result can be accessed through the `m`-variable.
    m.forEach((match, groupIndex) => {
      res.add(match)
    })
  }
  const keywordSet = new Set([
    "break",
    "case",
    "catch",
    "classdef",
    "continue",
    "else",
    "elseif",
    "end",
    "for",
    "function",
    "global",
    "if",
    "otherwise",
    "parfor",
    "persistent",
    "return",
    "spmd",
    "switch",
    "try",
    "while",
  ])

  return [...res].filter((v: any) => /[^0-9]\S+/.test(v) && !keywordSet.has(v)) as Array<string>
}

/**
 * Get the commands to show
 * @param {string} fileName file name
 * @param {string} content current file's content
 */
function getCommands(fileName: string, content: string): string[] {
  const dirPath = path.dirname(fileName)
  const dirPaths: Array<string> = [dirPath]

  let arr: Array<string> = []
  let addPaths = matchAddPath(content)
  addPaths.forEach((v) => {
    if (!path.isAbsolute(v)) {
      // relative to absolute
      v = path.join(dirPath, v)
    }
    dirPaths.push(v)
  })

  dirPaths.forEach((v) => {
    const mFileNames = fs
      .readdirSync(v)
      .filter((v: string) => v.endsWith(".m"))
      .map((v: string) => v.slice(0, v.length - 2))
    arr = arr.concat(mFileNames)
  })

  const quickSuggestions = getCurrentFileVariables(content)
  arr = arr.concat(quickSuggestions)

  return [...new Set(arr)]
}

/**
 * Get row / col from current file's content
 * @param {string} content current file's content
 * @param {string} word target word to search
 */
function getRowCol(content: string, word: string): { row: number, col: number } | null {
  // Case 1: in body.
  const reg = new RegExp(`\\b${word}\\s*=`, "m")
  const res = content.match(reg)
  if (res) {
    const rows = content.slice(0, res.index).split("\n")
    // row start at 0
    const row = rows.length - 1
    // col is last line's length
    const col = rows[row].length
    return { row, col }
  }

  // Case 2: in function declaration
  const FUNCTION_PART = "function "
  if (content.indexOf(FUNCTION_PART) !== -1) {
    // contains 'function '
    const arr = content.split("\n")
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].indexOf(FUNCTION_PART) !== -1) {
        const functionLine = arr[i]
        const regSingle = new RegExp(`\\b${word}\\b`)
        const resSingle = functionLine.match(regSingle)
        if (resSingle && resSingle.index) {
          return {
            row: i,
            col: resSingle.index,
          }
        }
        break
      }
    }
  }
  return null
}

/**
 * get variable selection occurence ranges in the code content.
 * @param content the code content
 * @param name the variable name
 */
function getRangesByName(content: string, name: string) {
  const regex = new RegExp(`\\b${name}\\b`, "g")
  let result: Array<{ row: number, column: number }> = []
  content.split("\n").forEach((v, i) => {
    let m
    while ((m = regex.exec(v)) !== null) {
      // This is necessary to avoid infinite loops with zero-width matches
      if (m.index === regex.lastIndex) {
        regex.lastIndex++
      }
      result.push({
        row: i,
        column: m.index
      })
    }
  })
  return result
}

/**
 * find struct member names in code content
 * @param fileName the file name
 * @param content the code content
 * @param structName the struct name
 */
function findMemberNames(fileName: string, content: string, structName: string): string[] {
  const regex = new RegExp(`\\s?${structName}\\.(\\S+);?`, 'gm')
  const res = TextUtils.matchAll(content, regex)
  let names = res.map(v => v[1].replace(';', '').replace(':', ''))
  // exclude variant member names
  names = names.filter(v => !v.includes('('))
  // unique it
  names = names.filter((v, i) => names.indexOf(v) === i)
  return names
}

function getStructNames (fileName: string, content: string) : string[] {
  // get all struct names
  const regex = /([a-zA-Z\_][0-9a-zA-Z\_]*)\./gm
  const res = TextUtils.matchAll(content, regex)
  let structNames = res.map(v => v[1])
  // unique it and exclude filename
  const basename = fileName.slice(0, fileName.length - 2)
  structNames = structNames.filter((v, i) => structNames.indexOf(v) === i && v !== basename)
  return structNames
}

/**
 * get struct completions from code content
 * @param content the code content
 */
function getStructCompletions(fileName: string, content: string): StructCompletion[] {
  // get all struct names
  const structNames = getStructNames(fileName, content)
  return structNames.map(name => {
    return {
      name: name,
      members: findMemberNames(fileName, content, name)
    }
  })
}

function getFunctionCall (content: string) : FunctionCall[] {
  let res : FunctionCall[] = []
  // multiple returns
  const regexMultiple = /\[(.+)\]\s*=\s*(\S+)\((.*)\)/g
  const resMultiple = TextUtils.matchAll(content, regexMultiple)
  res = res.concat(resMultiple.map(v => {
    return {
      name: v[2],
      returns: v[1].replace(/\s/g, '').split(','),
      params: v[3].replace(/\s/g, '').split(','),
    }
  }))
  return res
}

export default {
  getCommands,
  getRowCol,
  getCurrentFileVariables,
  getRangesByName,
  findMemberNames,
  getStructCompletions,
  getStructNames
}

const filePath = 'C:\\Users\\sheng\\Documents\\code\\matlab\\quaternion_matlab\\日常行为分析\\feature_visualize\\feature_range_3d\\range_to_feature_importance.m'
const content = readContent(filePath)
const res = getFunctionCall(content)
console.log(res)