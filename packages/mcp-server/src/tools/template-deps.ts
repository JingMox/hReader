// This layer: the package's single `TemplateDeps` for the four template tools (user tier root = `<home>/.hreader/templates`);
// `HREADER_HOME` relocates that root — the same convention the CLI's `configHomeOf` honors.

import { homedir } from "node:os";

import { nodeTemplateDeps, type TemplateDeps } from "@hreader/core";

export const templateDepsOf = (): TemplateDeps => {
  const envHome = process.env["HREADER_HOME"];
  return {
    ...nodeTemplateDeps(),
    home: envHome === undefined || envHome === "" ? homedir() : envHome,
  };
};
