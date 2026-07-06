import type { Tool } from "../types.ts";
import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";

export { bashTool, editTool, readTool, writeTool };
export { createTaskTool, type TaskInput, type TaskToolOptions } from "./task.ts";

/** The default toolset for a coding agent. */
export function coreTools(): Tool[] {
  return [bashTool, readTool, writeTool, editTool];
}
