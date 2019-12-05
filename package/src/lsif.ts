import * as sourcegraph from 'sourcegraph'

import * as LSP from 'vscode-languageserver-types'
import { convertLocations, convertHover } from './lsp-conversion'
import { queryGraphQL } from './api'
import { compareVersion } from './versions'

/** The date that the LSIF GraphQL API resolvers became available. */
const GRAPHQL_API_MINIMUM_DATE = '2019-12-01'

/** The version that the LSIF GraphQL API resolvers became available. */
const GRAPHQL_API_MINIMUM_VERSION = '3.11'

function repositoryFromDoc(doc: sourcegraph.TextDocument): string {
    const url = new URL(doc.uri)
    return url.hostname + url.pathname
}

function commitFromDoc(doc: sourcegraph.TextDocument): string {
    const url = new URL(doc.uri)
    return url.search.slice(1)
}

function pathFromDoc(doc: sourcegraph.TextDocument): string {
    const url = new URL(doc.uri)
    return url.hash.slice(1)
}

function setPath(doc: sourcegraph.TextDocument, path: string): string {
    if (path.startsWith('git://')) {
        return path
    }

    const url = new URL(doc.uri)
    url.hash = path
    return url.href
}

async function queryLSIF({
    doc,
    method,
    path,
    position,
}: {
    doc: sourcegraph.TextDocument
    method: string
    path: string
    position: LSP.Position
}): Promise<any> {
    const url = new URL(
        '.api/lsif/request',
        sourcegraph.internal.sourcegraphURL
    )
    url.searchParams.set('repository', repositoryFromDoc(doc))
    url.searchParams.set('commit', commitFromDoc(doc))

    const response = await fetch(url.href, {
        method: 'POST',
        headers: new Headers({
            'content-type': 'application/json',
            'x-requested-with': 'Basic code intel',
        }),
        body: JSON.stringify({
            method,
            path,
            position,
        }),
    })
    if (!response.ok) {
        throw new Error(`LSIF /request returned ${response.statusText}`)
    }
    return await response.json()
}

/**
 * Creates an asynchronous predicate on a doc that checks for the existence of
 * LSIF data for the given doc. It's a constructor because it creates an
 * internal cache to reduce network traffic.
 */
export const mkIsLSIFAvailable = () => {
    const lsifDocs = new Map<string, Promise<boolean>>()
    return (doc: sourcegraph.TextDocument): Promise<boolean> => {
        if (!sourcegraph.configuration.get().get('codeIntel.lsif')) {
            return Promise.resolve(false)
        }

        if (lsifDocs.has(doc.uri)) {
            return lsifDocs.get(doc.uri)!
        }

        const repository = repositoryFromDoc(doc)
        const commit = commitFromDoc(doc)
        const file = pathFromDoc(doc)

        const url = new URL(
            '.api/lsif/exists',
            sourcegraph.internal.sourcegraphURL
        )
        url.searchParams.set('repository', repository)
        url.searchParams.set('commit', commit)
        url.searchParams.set('file', file)

        const hasLSIFPromise = (async () => {
            try {
                // Prevent leaking the name of a private repository to
                // Sourcegraph.com by relying on the Sourcegraph extension host's
                // private repository detection, which will throw an error when
                // making a GraphQL request.
                await queryGraphQL({
                    query: `query { currentUser { id } }`,
                    vars: {},
                    sourcegraph,
                })
            } catch (e) {
                return false
            }
            const response = await fetch(url.href, {
                method: 'POST',
                headers: new Headers({
                    'x-requested-with': 'Basic code intel',
                }),
            })
            if (!response.ok) {
                return false
            }
            return response.json()
        })()

        lsifDocs.set(doc.uri, hasLSIFPromise)

        return hasLSIFPromise
    }
}

export async function hover(
    doc: sourcegraph.TextDocument,
    position: sourcegraph.Position
): Promise<sourcegraph.Hover | null> {
    const hover: LSP.Hover | null = await queryLSIF({
        doc,
        method: 'hover',
        path: pathFromDoc(doc),
        position,
    })
    if (!hover) {
        return null
    }
    return convertHover(sourcegraph, hover)
}

export async function definition(
    doc: sourcegraph.TextDocument,
    position: sourcegraph.Position
): Promise<sourcegraph.Definition | null> {
    const body: LSP.Location | LSP.Location[] | null = await queryLSIF({
        doc,
        method: 'definitions',
        path: pathFromDoc(doc),
        position,
    })
    if (!body) {
        return null
    }
    const locations = Array.isArray(body) ? body : [body]
    return convertLocations(
        sourcegraph,
        locations.map((definition: LSP.Location) => ({
            ...definition,
            uri: setPath(doc, definition.uri),
        }))
    )
}

export async function references(
    doc: sourcegraph.TextDocument,
    position: sourcegraph.Position
): Promise<sourcegraph.Location[] | null> {
    const locations: LSP.Location[] | null = await queryLSIF({
        doc,
        method: 'references',
        path: pathFromDoc(doc),
        position,
    })
    if (!locations) {
        return []
    }
    return convertLocations(
        sourcegraph,
        locations.map((reference: LSP.Location) => ({
            ...reference,
            uri: setPath(doc, reference.uri),
        }))
    )
}

/**
 * An optional value of type T. It's either `{ value: T }` or `undefined`.
 */
export type Maybe<T> = { value: T } | undefined

/**
 * Converts an async function that returns a type `ReturnType` to an async
 * function that returns the type `Maybe<ReturnType>`.
 */
export const wrapMaybe = <Arguments extends any[], ReturnType>(
    f: (...args: Arguments) => Promise<ReturnType>
) => async (...args: Arguments): Promise<Maybe<ReturnType>> => {
    const returnValue = await f(...args)
    return returnValue !== undefined ? { value: returnValue } : undefined
}

/**
 * Only runs the given async function `f` when the given sync predicate on the arguments
 * succeeds.
 */
export function when<Arguments extends any[], ReturnType>(
    predicate: (...args: Arguments) => boolean
): (
    f: (...args: Arguments) => Promise<ReturnType>
) => (...args: Arguments) => Promise<Maybe<ReturnType>> {
    return f => async (...args) =>
        predicate(...args) ? { value: await f(...args) } : undefined
}

/**
 * Only runs the given async function `f` when the given async predicate on the arguments
 * succeeds. Async version of `when`.
 */
export function asyncWhen<A extends any[], R>(
    asyncPredicate: (...args: A) => Promise<boolean>
): (f: (...args: A) => Promise<R>) => (...args: A) => Promise<Maybe<R>> {
    return f => async (...args) =>
        (await asyncPredicate(...args))
            ? { value: await f(...args) }
            : undefined
}

/**
 * Takes an array of async functions `fs` that return `Maybe<ReturnType>`, calls
 * each `f` in series, bails when one returns `{ value: ... }`, and returns that
 * value. Defaults to `defaultValue` when no `f` returns `{ value: ... }`.
 */
export const asyncFirst = <Arguments extends any[], ReturnType>(
    fs: ((...args: Arguments) => Promise<Maybe<ReturnType>>)[],
    defaultValue: ReturnType
) => async (...args: Arguments): Promise<ReturnType> => {
    for (const f of fs) {
        const maybeReturnValue = await f(...args)
        if (maybeReturnValue !== undefined) {
            return maybeReturnValue.value
        }
    }
    return defaultValue
}

export interface MaybeProviders {
    hover: (
        doc: sourcegraph.TextDocument,
        pos: sourcegraph.Position
    ) => Promise<Maybe<sourcegraph.Hover | null>>
    definition: (
        doc: sourcegraph.TextDocument,
        pos: sourcegraph.Position
    ) => Promise<Maybe<sourcegraph.Definition | null>>
    references: (
        doc: sourcegraph.TextDocument,
        pos: sourcegraph.Position
    ) => Promise<Maybe<sourcegraph.Location[] | null>>
}

export interface Providers {
    hover: (
        doc: sourcegraph.TextDocument,
        pos: sourcegraph.Position
    ) => Promise<sourcegraph.Hover | null>
    definition: (
        doc: sourcegraph.TextDocument,
        pos: sourcegraph.Position
    ) => Promise<sourcegraph.Definition | null>
    references: (
        doc: sourcegraph.TextDocument,
        pos: sourcegraph.Position
    ) => Promise<sourcegraph.Location[] | null>
}

export const noopMaybeProviders = {
    hover: () => Promise.resolve(undefined),
    definition: () => Promise.resolve(undefined),
    references: () => Promise.resolve(undefined),
}

export function initLSIF(): MaybeProviders {
    const provider = (async () => {
        if (await supportsGraphQL()) {
            console.log('Using LSIF GraphQL API')
            return initGraphQL()
        }

        console.log('Using LSIF HTTP API')
        return initHTTP()
    })()

    return {
        // If graphQL is supported, use the GraphQL implementation.
        // Otherwise, use the legacy HTTP implementation.
        definition: async (...args) => (await provider).definition(...args),
        references: async (...args) => (await provider).references(...args),
        hover: async (...args) => (await provider).hover(...args),
    }
}

async function supportsGraphQL(): Promise<boolean> {
    const query = `
        query SiteVersion {
            site {
                productVersion
            }
        }
    `

    const respObj = await queryGraphQL({
        query,
        vars: {},
        sourcegraph,
    })

    return compareVersion({
        productVersion: respObj.data.site.productVersion,
        minimumVersion: GRAPHQL_API_MINIMUM_VERSION,
        minimumDate: GRAPHQL_API_MINIMUM_DATE,
    })
}

function initHTTP(): MaybeProviders {
    const isLSIFAvailable = mkIsLSIFAvailable()

    return {
        // You can read this as "only send a hover request when LSIF data is
        // available for the given doc".
        hover: asyncWhen<
            [sourcegraph.TextDocument, sourcegraph.Position],
            sourcegraph.Hover | null
        >(isLSIFAvailable)(hover),
        definition: asyncWhen<
            [sourcegraph.TextDocument, sourcegraph.Position],
            sourcegraph.Definition | null
        >(isLSIFAvailable)(definition),
        references: asyncWhen<
            [sourcegraph.TextDocument, sourcegraph.Position],
            sourcegraph.Location[] | null
        >(isLSIFAvailable)(references),
    }
}

function initGraphQL(): MaybeProviders {
    const noLSIFData = new Set<string>()

    const cacheUndefined = <R>(
        f: (
            doc: sourcegraph.TextDocument,
            pos: sourcegraph.Position
        ) => Promise<Maybe<R>>
    ) => async (
        doc: sourcegraph.TextDocument,
        pos: sourcegraph.Position
    ): Promise<Maybe<R>> => {
        if (!sourcegraph.configuration.get().get('codeIntel.lsif')) {
            return undefined
        }

        if (noLSIFData.has(doc.uri)) {
            return undefined
        }

        const result = await f(doc, pos)
        if (result === undefined) {
            noLSIFData.add(doc.uri)
        }

        return result
    }

    return {
        definition: cacheUndefined(definitionGraphQL),
        references: cacheUndefined(referencesGraphQL),
        hover: cacheUndefined(hoverGraphQL),
    }
}

async function definitionGraphQL(
    doc: sourcegraph.TextDocument,
    position: sourcegraph.Position
): Promise<Maybe<sourcegraph.Definition | null>> {
    const query = `
        query Definitions($repository: String!, $commit: String!, $path: String!, $line: Int!, $character: Int!) {
            repository(name: $repository) {
                commit(rev: $commit) {
                    blob(path: $path) {
                        lsif {
                            definitions(line: $line, character: $character) {
                                nodes {
                                    resource {
                                        path
                                        repository {
                                            name
                                        }
                                        commit {
                                            oid
                                        }
                                    }
                                    range {
                                        start {
                                            line
                                            character
                                        }
                                        end {
                                            line
                                            character
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    `

    const lsifObj = await queryLSIFGraphQL<{
        definitions: { nodes: LocationConnectionNode[] }
    }>({ doc, query, position })

    return lsifObj && { value: lsifObj.definitions.nodes.map(nodeToLocation) }
}

async function referencesGraphQL(
    doc: sourcegraph.TextDocument,
    position: sourcegraph.Position
): Promise<Maybe<sourcegraph.Location[] | null>> {
    const query = `
        query References($repository: String!, $commit: String!, $path: String!, $line: Int!, $character: Int!) {
            repository(name: $repository) {
                commit(rev: $commit) {
                    blob(path: $path) {
                        lsif {
                            references(line: $line, character: $character) {
                                nodes {
                                    resource {
                                        path
                                        repository {
                                            name
                                        }
                                        commit {
                                            oid
                                        }
                                    }
                                    range {
                                        start {
                                            line
                                            character
                                        }
                                        end {
                                            line
                                            character
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    `

    const lsifObj = await queryLSIFGraphQL<{
        references: { nodes: LocationConnectionNode[] }
    }>({ doc, query, position })

    return lsifObj && { value: lsifObj.references.nodes.map(nodeToLocation) }
}

async function hoverGraphQL(
    doc: sourcegraph.TextDocument,
    position: sourcegraph.Position
): Promise<Maybe<sourcegraph.Hover | null>> {
    const query = `
        query Hover($repository: String!, $commit: String!, $path: String!, $line: Int!, $character: Int!) {
            repository(name: $repository) {
                commit(rev: $commit) {
                    blob(path: $path) {
                        lsif {
                            hover(line: $line, character: $character) {
                                text
                            }
                        }
                    }
                }
            }
        }
    `

    const lsifObj = await queryLSIFGraphQL<{ hover: { text: string } }>({
        doc,
        query,
        position,
    })

    return (
        lsifObj && {
            value: {
                contents: {
                    value: lsifObj.hover.text,
                    kind: sourcegraph.MarkupKind.Markdown,
                },
            },
        }
    )
}

async function queryLSIFGraphQL<T>({
    doc,
    query,
    position,
}: {
    doc: sourcegraph.TextDocument
    query: string
    position: LSP.Position
}): Promise<T | undefined> {
    repositoryFromDoc(doc)
    commitFromDoc(doc)

    const vars = {
        repository: repositoryFromDoc(doc),
        commit: commitFromDoc(doc),
        path: pathFromDoc(doc),
        line: position.line,
        character: position.character,
    }

    const respObj = await queryGraphQL({
        query,
        vars,
        sourcegraph,
    })

    // TODO - check errors
    return respObj.data.repository.commit.blob.lsif
}

type LocationConnectionNode = {
    resource: {
        path: string
        repository: { name: string }
        commit: { oid: string }
    }
    range: sourcegraph.Range
}

function nodeToLocation(node: LocationConnectionNode): sourcegraph.Location {
    return {
        uri: new sourcegraph.URI(
            `git://${node.resource.repository.name}?${node.resource.commit.oid}#${node.resource.path}`
        ),
        range: new sourcegraph.Range(
            node.range.start.line,
            node.range.start.character,
            node.range.end.line,
            node.range.end.character
        ),
    }
}
