import { AwaitableQueue } from "./awaitable-queue";
import { loadPyodide } from "./pyodide/pyodide";
import type { PyProxyCallable } from "./pyodide/pyodide";
import { uint8ArrayToString } from "./utils";

type Pyodide = Awaited<ReturnType<typeof loadPyodide>>;

export async function fetchASGI(
  client: MessagePort,
  resource: RequestInfo,
  init?: RequestInit,
  filter: (bodyChunk: Uint8Array, response: Response) => Uint8Array = (
    bodyChunk
  ) => bodyChunk
): Promise<Response> {
  if (typeof resource === "string" || typeof init !== "undefined") {
    resource = new Request(resource, init);
  }

  const channel = new MessageChannel();
  const clientPort = channel.port1;
  client.postMessage(
    {
      type: "makeRequest",
      scope: reqToASGI(resource),
    },
    [channel.port2]
  );

  const blob = await resource.blob();
  if (!blob.size) {
    clientPort.postMessage({
      type: "http.request",
      more_body: false,
    });
  } else {
    const reader = blob.stream().getReader();
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value: theChunk, done } = await reader.read();
        clientPort.postMessage({
          type: "http.request",
          body: theChunk,
          more_body: !done,
        });
        if (done) {
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  return new Promise((resolve) => {
    let streamController: ReadableStreamDefaultController | undefined;
    const readableStream = new ReadableStream({
      start(controller) {
        streamController = controller;
      },
      cancel(reason) {},
    });

    let response: Response | undefined;

    clientPort.addEventListener("message", (event) => {
      const msg = event.data;

      if (msg.type === "http.response.start") {
        // The response started; resolve the fetchASGI() call with a Response.
        // Next, we may or may not be receiving response body chunk(s).
        response = asgiToRes(msg, readableStream);
        resolve(response);
      } else if (msg.type === "http.response.body") {
        // response-body message received; report it to the ReadableStream via
        // its controller.
        if (msg.body) {
          streamController!.enqueue(filter(msg.body, response!));
        }
        if (!msg.more_body) {
          // All done
          streamController!.close();
          clientPort.close();
        }
      } else {
        throw new Error("Unexpected event type from clientPort: " + msg.type);
      }
    });
    clientPort.start();
  });
}

export async function makeRequest(
  scope: ASGIHTTPRequestScope,
  appName: string,
  clientPort: MessagePort,
  pyodide: Pyodide
) {
  // We could _almost_ use app(), but unfortunately pyodide's implicit proxying
  // behavior isn't compatible with ASGI (which wants dict, not JsProxy); we
  // need to explicitly convert stuff first, which is what call_pyodide does.
  const asgiFunc = pyodide.runPython(
    `_shiny_app_registry["${appName}"].app.call_pyodide`
  ) as PyProxyCallable;
  await connect(scope, clientPort, asgiFunc);
}

async function connect(
  scope: ASGIHTTPRequestScope,
  clientPort: MessagePort,
  asgiFunc: PyProxyCallable
) {
  const fromClientQueue = new AwaitableQueue<Record<string, any>>();

  clientPort.addEventListener("message", (event) => {
    if (event.data.type === "http.request") {
      fromClientQueue.enqueue({
        type: "http.request",
        body: event.data.body,
        more_body: event.data.more_body,
      });
    }
  });
  clientPort.start();

  async function fromClient(): Promise<Record<string, any>> {
    return fromClientQueue.dequeue();
  }

  async function toClient(event: Record<string, any>): Promise<void> {
    event = Object.fromEntries(event.toJs());
    if (event.type === "http.response.start") {
      clientPort.postMessage({
        type: event.type,
        status: event.status,
        headers: asgiHeadersToRecord(event.headers),
      });
    } else if (event.type === "http.response.body") {
      clientPort.postMessage({
        type: event.type,
        body: asgiBodyToArray(event.body),
        more_body: event.more_body,
      });
    } else {
      throw new Error(`Unhandled ASGI event: ${event.type}`);
    }
  }

  await asgiFunc(scope, fromClient, toClient);
}

function headersToASGI(headers: Headers): Array<Array<string>> {
  const result: Array<Array<string>> = [];
  for (const [key, value] of headers.entries()) {
    result.push([key, value]);
  }
  return result;
}

export interface ASGIHTTPRequestScope {
  type: "http";
  asgi: {
    version: "3.0";
    spec_version: "2.1";
  };
  http_version: "1.1";
  method: string;
  scheme: "http" | "https" | undefined;
  path: string;
  query_string: string;
  root_path: string;
  headers: Array<Array<string>>;
}

function reqToASGI(req: Request): ASGIHTTPRequestScope {
  const url = new URL(req.url);
  return {
    type: "http",
    asgi: {
      version: "3.0",
      spec_version: "2.1",
    },
    http_version: "1.1",
    method: req.method,
    scheme: url.protocol.replace(/:$/, "") as "http" | "https",
    path: url.pathname,
    query_string: url.search.replace(/^\?/, ""),
    root_path: "",
    headers: headersToASGI(req.headers),
  };
}

interface ASGIHttpResponse {
  type: "http.response.start";
  status: number;
  headers: Record<string, string>;
}

function asgiToRes(res: ASGIHttpResponse, body: ReadableStream): Response {
  return new Response(body, {
    headers: res.headers,
    status: res.status,
  });
}

function asgiHeadersToRecord(headers: any): Record<string, string> {
  headers = headers.map(([key, val]: [Uint8Array, Uint8Array]) => {
    return [uint8ArrayToString(key), uint8ArrayToString(val)];
  });
  return Object.fromEntries(headers);
}

function asgiBodyToArray(body: any): Uint8Array {
  // This seems not to be needed
  // return Uint8Array.from(body.toJs());
  return body;
}
