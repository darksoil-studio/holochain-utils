import { mapValues } from "@darksoil-studio/holochain-utils";
import { AsyncComputed, fromPromise } from "async-signals";
import { fromUint8Array, toUint8Array } from "js-base64";
import { Signal } from "signal-polyfill";
import { expect, it } from "vitest";

import { joinAsyncMap } from "../src";

class MemoHoloHashMap extends Map {
  constructor(fn) {
    super();
    this.fn = fn;
  }
  get(hash) {
    const strHash = fromUint8Array(hash);
    if (!super.get(strHash)) {
      this.set(strHash, this.fn(hash));
    }
    return super.get(strHash);
  }

  entries() {
    return Array.from(super.entries())
      .map(([h, v]) => {
        return [toUint8Array(h), v];
      })
      [Symbol.iterator]();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(() => r(), ms));

it("joinAsyncMap", async () => {
  const memoMap = new MemoHoloHashMap((id) =>
    fromPromise(async () => {
      await sleep(10);
      return id;
    }),
  );

  const hashes = [new Uint8Array([0]), new Uint8Array([1])];

  for (const h of hashes) {
    memoMap.get(h);
  }

  const j = new AsyncComputed(() =>
    joinAsyncMap(mapValues(memoMap, (s) => s.get())),
  );
  const w = new Signal.subtle.Watcher(() => {});
  w.watch(j);

  expect(j.get()).to.deep.equal({ status: "pending" });
  await sleep(20);

  expect(Array.from(j.get().value.entries()).length).to.deep.equal(2);
});

it("joinAsyncMap with error filtering", async () => {
  let first = true;
  const memoMap = new MemoHoloHashMap((hash) =>
    fromPromise(async () => {
      await sleep(10);
      if (first) {
        first = false;
        throw new Error("hi");
      }
      return hash;
    }),
  );

  const hashes = [new Uint8Array([0]), new Uint8Array([1])];

  for (const h of hashes) {
    memoMap.get(h);
  }

  const j = new AsyncComputed(() =>
    joinAsyncMap(
      mapValues(memoMap, (s) => s.get()),
      {
        errors: "filter_out",
      },
    ),
  );

  const w = new Signal.subtle.Watcher(() => {});
  w.watch(j);

  expect(j.get()).to.deep.equal({ status: "pending" });
  await sleep(20);

  expect(j.get().status).to.equal("completed");
  expect(Array.from(j.get().value.entries()).length).to.deep.equal(1);
});
