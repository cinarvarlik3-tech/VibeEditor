/**
 * remotion.config.js
 * Remotion configuration file.
 * Points Remotion at the project entry point and sets render concurrency.
 */

import { Config } from "@remotion/cli/config";

Config.setConcurrency(2);
Config.setEntryPoint("./src/index.js");
