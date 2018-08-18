import { createWebWorkerMessageTransports, Worker } from  'cxp/module/jsonrpc2/transports/webWorker'
import { InitializeResult, TextDocumentPositionParams, ReferenceParams,_InitializeParams, InitializeParams } from 'cxp/module/protocol'
import { DidOpenTextDocumentParams } from 'cxp/module/protocol/textDocument'
import { Connection, createConnection } from 'cxp/module/server/server'
import { Location } from 'vscode-languageserver-types'
import { fetchSearchResults, Result } from './api'

declare var self: Worker

/**
 * fileContents caches file contents from textDocument/didOpen notifications
 */
const fileContents = new Map<string, string>()

/**
 * identCharPattern is used to match identifier tokens
 */
const identCharPattern = /[A-Za-z0-9_]/

/**
 * authToken is the access token used to authenticate to the Sourcegraph API. This will be set in the
 * initialize handler.
 */
let configuration: Config;

/**
 * fileExtSets describe file extension sets that may contain references to one another.
 * The elements of this array *must* be disjoint sets. Don't refer to this variable directly.
 * Instead, call fileExtTerm.
 */
const fileExtsSets = [
    ['h', 'c', 'hpp', 'cpp', 'm', 'cc'],
    ['java'],
    ['go'],
    ['js'],
    ['ts'],
    ['rb', 'erb'],
    ['py'],
    ['php'],
    ['css'],
    ['cs'],
    ['sh'],
    ['scala'],
    ['erl'],
    ['r'],
    ['swift'],
    ['coffee'],
    ['pl'],
]
const fileExtToTerm = new Map<string, string>()
function initFileExtToTerm() {
    for (const s of fileExtsSets) {
        const extRegExp = `file:\.(${s.join('|')})$`
        for (const e of s) {
            fileExtToTerm.set(e, extRegExp)
        }
    }
}
initFileExtToTerm()

/**
 * fileExtTerm returns the search term to use to filter to specific file extensions
 */
function fileExtTerm(sourceFile: string): string {
    const i = sourceFile.lastIndexOf('.')
    if (i === -1) {
        return ''
    }
    const ext = sourceFile.substring(i + 1).toLowerCase()
    const match = fileExtToTerm.get(ext)
    if (match) {
        return match
    }
    return ''
}

/**
 * resultToLocation maps a search result to a LSP Location instance.
 */
function resultToLocation(res: Result): Location {
    return {
        uri: `git://${res.repo}?HEAD#${res.file}`,
        range: {
            start: res.start,
            end: res.end,
        },
    }
}

/**
 * Configuration for this extension.
 */
interface Config {
    token: string
    symbols: boolean
}

/**
 * getAuthToken extracts the Sourcegraph auth token from the merged settings received in
 * initialize params. Throws an error if the token is not present.
 */
function getConfig(params: InitializeParams): Config {
    const authTokErr = 'could not read Sourcegraph auth token from initialize params. Did you add an auth token in user settings?'
    let extCfg;
    try {
        extCfg = params.initializationOptions.settings.merged['cx-basic-code-intel']
    } catch(e) {
        throw new Error(authTokErr)
    }

    let token: string
    try {
        if (!extCfg.sourcegraphEndpoint.token || typeof(extCfg.sourcegraphEndpoint.token) != 'string') {
            throw new Error()
        }
        token =  extCfg.sourcegraphEndpoint.token
    } catch (e) {
        throw new Error(authTokErr)
    }

    let symbols: boolean
    try {
        symbols = extCfg.sourcegraphEndpoint.symbols
    } catch(e) {
        symbols = false
    }

    return {
        token: token,
        symbols: symbols,
    }
}

function register(connection: Connection): void {
    connection.onInitialize(
        params => {
            configuration = getConfig(params)
            return {
                capabilities: {
                    definitionProvider: true,
                    referencesProvider: true,
                    textDocumentSync: { openClose: true },
                },
            } as InitializeResult
        }
    )

    connection.onNotification(
        'textDocument/didOpen',
        (params: DidOpenTextDocumentParams): void => {
            fileContents.clear()
            fileContents.set(params.textDocument.uri, params.textDocument.text)
        }
    )

    connection.onRequest(
        'textDocument/definition',
        async (params: TextDocumentPositionParams): Promise<Location | Location[] | null> => {
            const contents = fileContents.get(params.textDocument.uri)
            if (!contents) {
                throw new Error('did not fetch file contents')
            }
            const lines = contents.split('\n')
            const line = lines[params.position.line]
            let end = line.length
            for (let c = params.position.character; c < line.length; c++) {
                if (!identCharPattern.test(line[c])) {
                    end = c
                    break
                }
            }
            let start = 0
            for (let c = params.position.character; c >= 0; c--) {
                if (!identCharPattern.test(line[c])) {
                    start = c + 1
                    break
                }
            }
            if (start >= end) {
                return null
            }
            const searchToken = line.substring(start, end)

            if (configuration.symbols) {
                const symbolResults = fetchSearchResults(configuration.token, `type:symbol case:yes ${fileExtTerm(params.textDocument.uri)} \\b${searchToken}\\b`)
                const textResults = fetchSearchResults(configuration.token, `type:file case:yes ${fileExtTerm(params.textDocument.uri)} \\b${searchToken}\\b`)
                let results = await symbolResults
                if (results.length === 0) {
                    results = await textResults
                }
                return results.map(resultToLocation)
            } else {
                return (await fetchSearchResults(configuration.token, `type:file case:yes ${fileExtTerm(params.textDocument.uri)} \\b${searchToken}\\b`)).map(resultToLocation)
            }
        }
    )

    connection.onRequest(
        'textDocument/references',
        async (params: ReferenceParams): Promise<Location[] | null> => {
            const contents = fileContents.get(params.textDocument.uri)
            if (!contents) {
                throw new Error('did not fetch file contents')
            }
            const lines = contents.split('\n')
            const line = lines[params.position.line]
            let end = line.length
            for (let c = params.position.character; c < line.length; c++) {
                if (!identCharPattern.test(line[c])) {
                    end = c
                    break
                }
            }
            let start = 0
            for (let c = params.position.character; c >= 0; c--) {
                if (!identCharPattern.test(line[c])) {
                    start = c + 1
                    break
                }
            }
            if (start >= end) {
                return null
            }
            const searchToken = line.substring(start, end)

            const results = await fetchSearchResults(configuration.token, `type:file case:yes ${fileExtTerm(params.textDocument.uri)} \\b${searchToken}\\b`)
            return results.map(resultToLocation)
        }
    )
}

const connection = createConnection(createWebWorkerMessageTransports(self))
register(connection)
connection.listen()
