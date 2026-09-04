#!/usr/bin/env node

import { main } from "./continue-thread.js";

process.exitCode = await main(process.argv.slice(2), process.env);
