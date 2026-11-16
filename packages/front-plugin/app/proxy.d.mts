// Types for the plain-JS proxy that ships in the zip and runs under Node.

/** A capture body is one conversation; anything much larger is not one. */
export declare const MAX_BODY_BYTES: number;

/** The one path the proxy forwards. */
export declare const CAPTURE_PATH: string;

/** Forwards `POST /v1/capture` to Overturn with the project key attached server-side. */
export declare function createCaptureProxy(opts: {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  log?: (message: string, error?: unknown) => void;
}): (req: unknown, res: unknown) => Promise<void>;
