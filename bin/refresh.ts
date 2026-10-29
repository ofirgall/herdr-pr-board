#!/usr/bin/env bun
// The refresh action. The board owns the poll loop, so this only leaves a
// marker that the board picks up within a second.

import { requestRefresh } from "../src/state.ts";

await requestRefresh();
