import { serveWorkerTasks } from "../infra/worker-task-server.js";
import {
  readControlUiFile,
  type ControlUiFileRead,
  type ControlUiFileSnapshot,
} from "./control-ui-file.js";

serveWorkerTasks<ControlUiFileSnapshot | null, ControlUiFileRead>(readControlUiFile, {
  transferList: (snapshot) =>
    snapshot?.body?.buffer instanceof ArrayBuffer ? [snapshot.body.buffer] : [],
});
