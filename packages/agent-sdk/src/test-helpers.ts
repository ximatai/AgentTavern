import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

export class FakeChildProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killCalls: Array<string | number> = [];

  kill(signal?: string | number) {
    this.killCalls.push(signal ?? "SIGTERM");
    return true;
  }
}
