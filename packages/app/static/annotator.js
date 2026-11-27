// hReader annotator stub (F3b1). The server's annotate mode injects this into
// foreign-document frames; the real selection/annotation engine lands in F3b2.
// Contract: one hello to the parent, once on load, and nothing else — no
// globals, no listeners, no storage.
(() => {
  "use strict";
  window.parent.postMessage({ type: "hr-annotator/hello", version: 1 }, "*");
})();
