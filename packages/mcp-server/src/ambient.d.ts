// This layer: patches the SDK's type declarations — `@modelcontextprotocol/sdk`'s
// `dist/esm/shared/transport.d.ts` uses the DOM `HeadersInit`, while this repo's `lib` is only ES2023
// and `skipLibCheck: false` (dependency .d.ts files are checked too). The Node-side equivalent is the global
// `RequestInit["headers"]`; here we only wire up the name, not a second definition.
// Delete this file once the SDK ships the type — `tsc` will then fail to find `HeadersInit`, which is exactly the signal to remove it.
// This file holds global declarations: nothing but the line below is allowed here.

type HeadersInit = NonNullable<RequestInit["headers"]>;
