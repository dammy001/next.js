/* global location */
import '../build/polyfills/polyfill-module'
// @ts-ignore react-dom/client exists when using React 18
import ReactDOMClient from 'react-dom/client'
// @ts-ignore startTransition exists when using React 18
import React from 'react'
import { createFromReadableStream } from 'next/dist/compiled/react-server-dom-webpack'

/// <reference types="react-dom/experimental" />

// Override chunk URL mapping in the webpack runtime
// https://github.com/webpack/webpack/blob/2738eebc7880835d88c727d364ad37f3ec557593/lib/RuntimeGlobals.js#L204

declare global {
  const __webpack_require__: any
}

// eslint-disable-next-line no-undef
const getChunkScriptFilename = __webpack_require__.u
const chunkFilenameMap: any = {}

// eslint-disable-next-line no-undef
__webpack_require__.u = (chunkId: any) => {
  return chunkFilenameMap[chunkId] || getChunkScriptFilename(chunkId)
}

// Ignore the module ID transform in client.
// eslint-disable-next-line no-undef
// @ts-expect-error TODO: fix type
self.__next_require__ = __webpack_require__

// eslint-disable-next-line no-undef
;(self as any).__next_chunk_load__ = (chunk: string) => {
  if (!chunk) return Promise.resolve()
  if (chunk.endsWith('.css')) {
    const existingTag = document.querySelector(`link[href="${chunk}"]`)
    if (!existingTag) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = '/_next/' + chunk
      document.head.appendChild(link)
    }
    return Promise.resolve()
  }

  const [chunkId, chunkFileName] = chunk.split(':')
  chunkFilenameMap[chunkId] = `static/chunks/${chunkFileName}.js`

  // @ts-ignore
  // eslint-disable-next-line no-undef
  return __webpack_chunk_load__(chunkId)
}

export const version = process.env.__NEXT_VERSION

const appElement: HTMLElement | Document | null = document

let reactRoot: any = null

function renderReactElement(
  domEl: HTMLElement | Document,
  fn: () => JSX.Element
): void {
  const reactEl = fn()
  if (!reactRoot) {
    // Unlike with createRoot, you don't need a separate root.render() call here
    reactRoot = (ReactDOMClient as any).hydrateRoot(domEl, reactEl)
  } else {
    reactRoot.render(reactEl)
  }
}

const getCacheKey = () => {
  const { pathname, search } = location
  return pathname + search
}

const encoder = new TextEncoder()

let initialServerDataBuffer: string[] | undefined = undefined
let initialServerDataWriter: ReadableStreamDefaultController | undefined =
  undefined
let initialServerDataLoaded = false
let initialServerDataFlushed = false

function nextServerDataCallback(seg: [number, string, string]) {
  if (seg[0] === 0) {
    initialServerDataBuffer = []
  } else {
    if (!initialServerDataBuffer)
      throw new Error('Unexpected server data: missing bootstrap script.')

    if (initialServerDataWriter) {
      initialServerDataWriter.enqueue(encoder.encode(seg[2]))
    } else {
      initialServerDataBuffer.push(seg[2])
    }
  }
}

// There might be race conditions between `nextServerDataRegisterWriter` and
// `DOMContentLoaded`. The former will be called when React starts to hydrate
// the root, the latter will be called when the DOM is fully loaded.
// For streaming, the former is called first due to partial hydration.
// For non-streaming, the latter can be called first.
// Hence, we use two variables `initialServerDataLoaded` and
// `initialServerDataFlushed` to make sure the writer will be closed and
// `initialServerDataBuffer` will be cleared in the right time.
function nextServerDataRegisterWriter(ctr: ReadableStreamDefaultController) {
  if (initialServerDataBuffer) {
    initialServerDataBuffer.forEach((val) => {
      ctr.enqueue(encoder.encode(val))
    })
    if (initialServerDataLoaded && !initialServerDataFlushed) {
      ctr.close()
      initialServerDataFlushed = true
      initialServerDataBuffer = undefined
    }
  }

  initialServerDataWriter = ctr
}

// When `DOMContentLoaded`, we can close all pending writers to finish hydration.
const DOMContentLoaded = function () {
  if (initialServerDataWriter && !initialServerDataFlushed) {
    initialServerDataWriter.close()
    initialServerDataFlushed = true
    initialServerDataBuffer = undefined
  }
  initialServerDataLoaded = true
}
// It's possible that the DOM is already loaded.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', DOMContentLoaded, false)
} else {
  DOMContentLoaded()
}

const nextServerDataLoadingGlobal = ((self as any).__next_s =
  (self as any).__next_s || [])
nextServerDataLoadingGlobal.forEach(nextServerDataCallback)
nextServerDataLoadingGlobal.push = nextServerDataCallback

function createResponseCache() {
  return new Map<string, any>()
}
const rscCache = createResponseCache()

async function loadCss(cssChunkInfoJson: string) {
  const data = JSON.parse(cssChunkInfoJson)
  await Promise.all(
    data.chunks.map((chunkId: string) => {
      // load css related chunks
      return (self as any).__next_chunk_load__(chunkId)
    })
  )
  // In development mode, import css in dev when it's wrapped by style loader.
  // In production mode, css are standalone chunk that doesn't need to be imported.
  if (data.id) {
    return (self as any).__next_require__(data.id)
  }

  return Promise.resolve()
}

function createLoadFlightCssStream(onFlightCssLoaded: () => void) {
  const promises: Promise<any>[] = []
  let cssFlushed = false

  const loadCssFromStreamData = (data: string) => {
    if (data.startsWith('CSS')) {
      const cssJson = data.slice(4).trim()
      promises.push(loadCss(cssJson))
    }
  }

  // TODO-APP: Refine the buffering code here to make it more correct.
  let buffer = ''
  const loadCssFromFlight = new TransformStream({
    transform(chunk, controller) {
      const process = (buf: string) => {
        if (buf) {
          if (buf.startsWith('CSS:')) {
            loadCssFromStreamData(buf)
          } else {
            controller.enqueue(new TextEncoder().encode(buf))

            if (!cssFlushed) {
              cssFlushed = true
              Promise.all(promises).then(() => onFlightCssLoaded())
            }
          }
        }
      }

      const data = new TextDecoder().decode(chunk)
      buffer += data
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index + 1)
        buffer = buffer.slice(index + 1)
        process(line)
      }
      process(buffer)
      buffer = ''
    },
  })

  return loadCssFromFlight
}

function useInitialServerResponse(
  cacheKey: string,
  onFlightCssLoaded: () => void
) {
  const response = rscCache.get(cacheKey)
  if (response) return response

  const readable = new ReadableStream({
    start(controller) {
      nextServerDataRegisterWriter(controller)
    },
  })

  const newResponse = createFromReadableStream(
    readable.pipeThrough(createLoadFlightCssStream(onFlightCssLoaded))
  )

  rscCache.set(cacheKey, newResponse)
  return newResponse
}

function ServerRoot({
  cacheKey,
  onFlightCssLoaded,
}: {
  cacheKey: string
  onFlightCssLoaded: () => Promise<void>
}) {
  React.useEffect(() => {
    rscCache.delete(cacheKey)
  })
  const response = useInitialServerResponse(cacheKey, onFlightCssLoaded)
  const root = response.readRoot()
  return root
}

function Root({ children }: React.PropsWithChildren<{}>): React.ReactElement {
  if (process.env.__NEXT_TEST_MODE) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    React.useEffect(() => {
      window.__NEXT_HYDRATED = true

      if (window.__NEXT_HYDRATED_CB) {
        window.__NEXT_HYDRATED_CB()
      }
    }, [])
  }

  return children as React.ReactElement
}

function RSCComponent(props: any) {
  const cacheKey = getCacheKey()
  return <ServerRoot {...props} cacheKey={cacheKey} />
}

export function hydrate(opts?: { onFlightCssLoaded?: () => Promise<void> }) {
  renderReactElement(appElement!, () => (
    <React.StrictMode>
      <Root>
        <RSCComponent onFlightCssLoaded={opts?.onFlightCssLoaded} />
      </Root>
    </React.StrictMode>
  ))
}
