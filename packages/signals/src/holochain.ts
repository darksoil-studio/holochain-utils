import {
  ActionCommittedSignal,
  EntryRecord,
  HashType,
  HoloHashMap,
  LinkTypeForSignal,
  ZomeClient,
  getHashType,
  retype,
} from "@darksoil-studio/holochain-utils";
import {
  Action,
  ActionHash,
  CreateLink,
  Delete,
  DeleteLink,
  HoloHash,
  Link,
  SignedActionHashed,
  decodeHashFromBase64,
  encodeHashToBase64,
} from "@holochain/client";
import { encode } from "@msgpack/msgpack";
import { AsyncResult, AsyncSignal } from "async-signals";
import cloneDeep from "lodash-es/cloneDeep.js";
import { Signal } from "signal-polyfill";

const DEFAULT_POLL_INTERVAL_MS = 20_000; // 20 seconds

export function createLinkToLink(
  createLink: SignedActionHashed<CreateLink>,
): Link {
  return {
    base: createLink.hashed.content.base_address,
    author: createLink.hashed.content.author,
    link_type: createLink.hashed.content.link_type,
    tag: createLink.hashed.content.tag,
    target: createLink.hashed.content.target_address,
    timestamp: createLink.hashed.content.timestamp,
    zome_index: createLink.hashed.content.zome_index,
    create_link_hash: createLink.hashed.hash,
  };
}

/**
 * Keeps an up to date list of the targets for the non-deleted links for the given collection in this DHT
 * Makes requests only while it has some subscriber
 *
 * Will do so by calling the given every 20 seconds calling the given fetch function,
 * and listening to `LinkCreated` and `LinkDeleted` signals
 *
 * Useful for collections
 */
export function collectionSignal<
  S extends ActionCommittedSignal<any, any> & any,
>(
  client: ZomeClient<S>,
  fetchCollection: () => Promise<Link[]>,
  linkType: string,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): AsyncSignal<Array<Link>> {
  let active = false;
  let unsubs: () => void | undefined;
  const signal = new Signal.State<AsyncResult<Array<Link>>>(
    { status: "pending" },
    {
      [Signal.subtle.watched]: () => {
        active = true;
        let links: Link[];

        const maybeSet = (newLinksValue: Link[]) => {
          if (!active) return;
          const orderedNewLinks = uniquifyLinks(
            newLinksValue ? newLinksValue : [],
          ).sort(sortLinksByTimestampAscending);
          if (
            !links ||
            !areArrayHashesEqual(
              orderedNewLinks.map((l) => l.create_link_hash),
              links.map((l) => l.create_link_hash),
            )
          ) {
            links = orderedNewLinks;
            signal.set({
              status: "completed",
              value: links,
            });
          }
        };

        const fetch = () => {
          if (!active) return;
          fetchCollection()
            .then(maybeSet)
            .catch((e) =>
              signal.set({
                status: "error",
                error: e,
              }),
            )
            .finally(() => {
              if (active) {
                setTimeout(() => fetch(), pollIntervalMs);
              }
            });
        };
        fetch();
        unsubs = client.onSignal((originalSignal) => {
          if (!(originalSignal as ActionCommittedSignal<any, any>).type) return;
          const signal = originalSignal as ActionCommittedSignal<any, any>;

          if (signal.type === "LinkCreated") {
            if (linkType === signal.link_type) {
              maybeSet([...(links || []), createLinkToLink(signal.action)]);
            }
          } else if (signal.type === "LinkDeleted") {
            if (linkType === signal.link_type) {
              maybeSet(
                (links || []).filter(
                  (link) =>
                    encodeHashToBase64(link.create_link_hash) !==
                    encodeHashToBase64(signal.create_link_action.hashed.hash),
                ),
              );
            }
          }
        });
      },
      [Signal.subtle.unwatched]: () => {
        signal.set({
          status: "pending",
        });
        active = false;
        unsubs();
      },
    },
  );

  return signal;
}

export class NotFoundError extends Error {
  constructor() {
    super("NOT_FOUND");
  }
}

export class ConflictingUpdatesError extends Error {
  constructor(public conflictingUpdates: Array<EntryRecord<any>>) {
    super("CONFLICTING_UPDATES");
  }
}

/**
 * Fetches the given entry, retrying if there is a failure
 *
 * Makes requests only the first time it is subscribed to,
 * and will stop after it succeeds in fetching the entry
 *
 * Whenever it succeeds, it caches the value so that any subsequent requests are cached
 *
 * Useful for entries that can't be updated
 */
export function immutableEntrySignal<T>(
  fetch: () => Promise<EntryRecord<T> | undefined>,
  pollInterval: number = 1000,
  maxRetries = 4,
): AsyncSignal<EntryRecord<T>> {
  let cached = false;
  const signal = new Signal.State<AsyncResult<EntryRecord<T>>>(
    { status: "pending" },
    {
      [Signal.subtle.watched]: () => {
        if (cached) return;
        let retries = 0;

        const tryFetch = () => {
          retries += 1;
          fetch()
            .then((value) => {
              if (value) {
                cached = true;
                signal.set({
                  status: "completed",
                  value,
                });
              } else {
                if (retries < maxRetries) {
                  setTimeout(() => tryFetch(), pollInterval);
                } else {
                  signal.set({
                    status: "error",
                    error: new NotFoundError(),
                  });
                }
              }
            })
            .catch((error) => {
              if (retries < maxRetries) {
                setTimeout(() => tryFetch(), pollInterval);
              } else {
                signal.set({
                  status: "error",
                  error,
                });
              }
            });
        };
        tryFetch();
      },
      [Signal.subtle.unwatched]: () => {
        if (cached) return;
        signal.set({
          status: "pending",
        });
      },
    },
  );

  return signal;
}

/**
 * Keeps an up to date copy of the latest version of an entry
 * Makes requests only while it has some subscriber
 *
 * Will do so by calling the given every 20 seconds calling the given fetch function,
 * and listening to `EntryUpdated` signals
 *
 * Useful for entries that can be updated
 */
export function latestVersionOfEntrySignal<
  T,
  S extends ActionCommittedSignal<any, any> & any,
>(
  client: ZomeClient<S>,
  fetchLatestVersion: () => Promise<EntryRecord<T> | undefined>,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): AsyncSignal<EntryRecord<T>> {
  let active = false;
  let unsubs: () => void | undefined;
  let latestVersion: EntryRecord<T> | undefined;

  const signal = new Signal.State<AsyncResult<EntryRecord<T>>>(
    { status: "pending" },
    {
      [Signal.subtle.watched]: () => {
        active = true;
        const fetch = async () => {
          if (!active) return;
          try {
            const nlatestVersion = await fetchLatestVersion();
            if (nlatestVersion) {
              if (
                !latestVersion ||
                encodeHashToBase64(latestVersion.actionHash) !==
                  encodeHashToBase64(nlatestVersion.actionHash)
              ) {
                latestVersion = nlatestVersion;
                signal.set({
                  status: "completed",
                  value: latestVersion,
                });
              }
            } else {
              signal.set({
                status: "error",
                error: new NotFoundError(),
              });
            }
          } catch (e) {
            signal.set({
              status: "error",
              error: e,
            });
          } finally {
            if (active) {
              setTimeout(() => fetch(), pollIntervalMs);
            }
          }
        };
        fetch();
        unsubs = client.onSignal((originalSignal) => {
          if (!active) return;
          if (!(originalSignal as ActionCommittedSignal<any, any>).type) return;
          const hcSignal = originalSignal as ActionCommittedSignal<any, any>;

          if (
            hcSignal.type === "EntryUpdated" &&
            latestVersion &&
            encodeHashToBase64(latestVersion.actionHash) ===
              encodeHashToBase64(
                hcSignal.action.hashed.content.original_action_address,
              )
          ) {
            latestVersion = new EntryRecord({
              entry: {
                Present: {
                  entry_type: "App",
                  entry: encode(hcSignal.app_entry),
                },
              },
              signed_action: hcSignal.action,
            });
            signal.set({
              status: "completed",
              value: latestVersion,
            });
          }
        });
      },
      [Signal.subtle.unwatched]: () => {
        signal.set({
          status: "pending",
        });
        active = false;
        latestVersion = undefined;
        unsubs();
      },
    },
  );

  return signal;
}

/**
 * Keeps an up to date list of all the revisions for an entry
 * Makes requests only while it has some subscriber
 *
 * Will do so by calling the given every 20 seconds calling the given fetch function,
 * and listening to `EntryUpdated` signals
 *
 * Useful for entries that can be updated
 */
export function allRevisionsOfEntrySignal<
  T,
  S extends ActionCommittedSignal<any, any> & any,
>(
  client: ZomeClient<S>,
  fetchAllRevisions: () => Promise<Array<EntryRecord<T>>>,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): AsyncSignal<Array<EntryRecord<T>>> {
  let active = false;
  let unsubs: () => void | undefined;
  let allRevisions: Array<EntryRecord<T>> | undefined;
  const signal = new Signal.State<AsyncResult<Array<EntryRecord<T>>>>(
    { status: "pending" },
    {
      [Signal.subtle.watched]: () => {
        active = true;
        const fetch = async () => {
          if (!active) return;

          const nAllRevisions = await fetchAllRevisions().finally(() => {
            if (active) {
              setTimeout(() => fetch(), pollIntervalMs);
            }
          });
          if (
            !allRevisions ||
            !areArrayHashesEqual(
              allRevisions.map((r) => r.actionHash),
              nAllRevisions.map((r) => r.actionHash),
            )
          ) {
            allRevisions = nAllRevisions;
            signal.set({
              status: "completed",
              value: allRevisions,
            });
          }
        };
        fetch().catch((error) => {
          signal.set({
            status: "error",
            error,
          });
        });
        unsubs = client.onSignal(async (originalSignal) => {
          if (!active) return;
          if (!(originalSignal as ActionCommittedSignal<any, any>).type) return;
          const hcSignal = originalSignal as ActionCommittedSignal<any, any>;

          if (
            hcSignal.type === "EntryUpdated" &&
            allRevisions &&
            allRevisions.find(
              (revision) =>
                encodeHashToBase64(revision.actionHash) ===
                encodeHashToBase64(
                  hcSignal.action.hashed.content.original_action_address,
                ),
            )
          ) {
            const newRevision = new EntryRecord<T>({
              entry: {
                Present: {
                  entry_type: "App",
                  entry: encode(hcSignal.app_entry),
                },
              },
              signed_action: hcSignal.action,
            });
            allRevisions.push(newRevision);
            signal.set({
              status: "completed",
              value: allRevisions,
            });
          }
        });
      },
      [Signal.subtle.unwatched]: () => {
        signal.set({
          status: "pending",
        });
        active = false;
        allRevisions = undefined;
        unsubs();
      },
    },
  );

  return signal;
}

/**
 * Keeps an up to date list of the deletes for an entry
 * Makes requests only while it has some subscriber
 *
 * Will do so by calling the given every 20 seconds calling the given fetch function,
 * and listening to `EntryDeleted` signals
 *
 * Useful for entries that can be deleted
 */
export function deletesForEntrySignal<
  S extends ActionCommittedSignal<any, any> & any,
>(
  client: ZomeClient<S>,
  originalActionHash: ActionHash,
  fetchDeletes: () => Promise<Array<SignedActionHashed<Delete>> | undefined>,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): AsyncSignal<Array<SignedActionHashed<Delete>>> {
  let active = false;
  let unsubs: () => void | undefined;
  let deletes: Array<SignedActionHashed<Delete>> | undefined;
  const signal = new Signal.State<
    AsyncResult<Array<SignedActionHashed<Delete>>>
  >(
    { status: "pending" },
    {
      [Signal.subtle.watched]: () => {
        active = true;
        const fetch = async () => {
          if (!active) return;

          const ndeletes = await fetchDeletes().finally(() => {
            if (active) {
              setTimeout(() => fetch(), pollIntervalMs);
            }
          });
          if (
            ndeletes &&
            (!deletes ||
              !areArrayHashesEqual(
                deletes.map((d) => d.hashed.hash),
                ndeletes.map((d) => d.hashed.hash),
              ))
          ) {
            deletes = uniquifyActions(ndeletes);
            signal.set({
              status: "completed",
              value: deletes,
            });
          }
        };
        fetch().catch((error) => {
          signal.set({
            status: "error",
            error,
          });
        });
        unsubs = client.onSignal((originalSignal) => {
          if (!active) return;
          if (!(originalSignal as ActionCommittedSignal<any, any>).type) return;
          const hcSignal = originalSignal as ActionCommittedSignal<any, any>;

          if (
            hcSignal.type === "EntryDeleted" &&
            encodeHashToBase64(
              hcSignal.action.hashed.content.deletes_address,
            ) === encodeHashToBase64(originalActionHash)
          ) {
            const lastDeletes = deletes ? deletes : [];
            deletes = uniquifyActions([...lastDeletes, hcSignal.action]);
            signal.set({
              status: "completed",
              value: deletes,
            });
          }
        });
      },
      [Signal.subtle.unwatched]: () => {
        signal.set({
          status: "pending",
        });
        active = false;
        deletes = undefined;
        unsubs();
      },
    },
  );

  return signal;
}

export const sortLinksByTimestampAscending = (linkA: Link, linkB: Link) =>
  linkA.timestamp - linkB.timestamp;
export const sortDeletedLinksByTimestampAscending = (
  linkA: [SignedActionHashed<CreateLink>, SignedActionHashed<DeleteLink>[]],
  linkB: [SignedActionHashed<CreateLink>, SignedActionHashed<DeleteLink>[]],
) => linkA[0].hashed.content.timestamp - linkB[0].hashed.content.timestamp;
export const sortActionsByTimestampAscending = (
  actionA: SignedActionHashed<any>,
  actionB: SignedActionHashed<any>,
) => actionA.hashed.content.timestamp - actionB.hashed.content.timestamp;

export function uniquify<H extends HoloHash>(array: Array<H>): Array<H> {
  const strArray = array.map((h) => encodeHashToBase64(h));
  const uniqueArray = [...new Set(strArray)];
  return uniqueArray.map((h) => decodeHashFromBase64(h) as H);
}

export function uniquifyLinks(links: Array<Link>): Array<Link> {
  const map = new HoloHashMap<ActionHash, Link>();
  for (const link of links) {
    map.set(link.create_link_hash, link);
  }

  return Array.from(map.values());
}

function areArrayHashesEqual(
  array1: Array<HoloHash>,
  array2: Array<HoloHash>,
): boolean {
  if (array1.length !== array2.length) return false;

  for (let i = 0; i < array1.length; i += 1) {
    if (encodeHashToBase64(array1[i]) !== encodeHashToBase64(array2[i])) {
      return false;
    }
  }

  return true;
}

function uniquifyActions<T extends Action>(
  actions: Array<SignedActionHashed<T>>,
): Array<SignedActionHashed<T>> {
  const map = new HoloHashMap<ActionHash, SignedActionHashed<T>>();
  for (const a of actions) {
    map.set(a.hashed.hash, a);
  }

  return Array.from(map.values());
}

/**
 * Keeps an up to date list of the links for the non-deleted links in this DHT
 * Makes requests only while it has some subscriber
 *
 * Will do so by calling the given fetch callback every 20 seconds,
 * and listening to `LinkCreated` and `LinkDeleted` signals
 *
 * Useful for link types
 */
export function liveLinksSignal<
  BASE extends HoloHash,
  S extends ActionCommittedSignal<any, any> & any,
>(
  client: ZomeClient<S>,
  baseAddress: BASE,
  fetchLinks: () => Promise<Array<Link>>,
  linkType: LinkTypeForSignal<S>,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): AsyncSignal<Array<Link>> {
  let innerBaseAddress = baseAddress;
  if (getHashType(innerBaseAddress) === HashType.AGENT) {
    innerBaseAddress = retype(innerBaseAddress, HashType.ENTRY) as BASE;
  }

  let active = false;
  let unsubs: () => void | undefined;

  let links: Array<Link> | undefined;
  const signal = new Signal.State<AsyncResult<Array<Link>>>(
    { status: "pending" },
    {
      [Signal.subtle.watched]: () => {
        active = true;

        const maybeSet = (newLinksValue: Link[]) => {
          if (!active) return;
          const orderedNewLinks = uniquifyLinks(
            newLinksValue ? newLinksValue : [],
          ).sort(sortLinksByTimestampAscending);

          if (
            !links ||
            !areArrayHashesEqual(
              orderedNewLinks.map((l) => l.create_link_hash),
              links.map((l) => l.create_link_hash),
            )
          ) {
            links = orderedNewLinks;
            signal.set({
              status: "completed",
              value: links,
            });
          }
        };
        const fetch = async () => {
          if (!active) return;
          fetchLinks()
            .then(maybeSet)
            .finally(() => {
              if (active) {
                setTimeout(() => fetch(), pollIntervalMs);
              }
            });
        };

        fetch().catch((error) => {
          signal.set({
            status: "error",
            error,
          });
        });
        unsubs = client.onSignal((originalSignal) => {
          if (!(originalSignal as ActionCommittedSignal<any, any>).type) return;
          const hcSignal = originalSignal as ActionCommittedSignal<any, any>;

          if (hcSignal.type === "LinkCreated") {
            if (
              linkType === hcSignal.link_type &&
              (encodeHashToBase64(
                hcSignal.action.hashed.content.base_address,
              ) === encodeHashToBase64(innerBaseAddress) ||
                encodeHashToBase64(
                  retype(
                    hcSignal.action.hashed.content.base_address,
                    HashType.AGENT,
                  ),
                ) === encodeHashToBase64(innerBaseAddress))
            ) {
              const lastLinks = links ? links : [];
              maybeSet([...lastLinks, createLinkToLink(hcSignal.action)]);
            }
          } else if (hcSignal.type === "LinkDeleted") {
            if (
              linkType === hcSignal.link_type &&
              encodeHashToBase64(
                hcSignal.create_link_action.hashed.content.base_address,
              ) === encodeHashToBase64(innerBaseAddress)
            ) {
              maybeSet(
                (links ? links : []).filter(
                  (link) =>
                    encodeHashToBase64(link.create_link_hash) !==
                    encodeHashToBase64(hcSignal.create_link_action.hashed.hash),
                ),
              );
            }
          }
        });
      },

      [Signal.subtle.unwatched]: () => {
        signal.set({
          status: "pending",
        });
        active = false;
        links = undefined;
        unsubs();
      },
    },
  );

  return signal;
}

/**
 * Keeps an up to date list of the targets for the deleted links in this DHT
 * Makes requests only while it has some subscriber
 *
 * Will do so by calling the given every 20 seconds calling the given fetch function,
 * and listening to `LinkDeleted` signals
 *
 * Useful for link types and collections with some form of archive retrieving functionality
 */
export function deletedLinksSignal<
  BASE extends HoloHash,
  S extends ActionCommittedSignal<any, any> & any,
>(
  client: ZomeClient<S>,
  baseAddress: BASE,
  fetchDeletedLinks: () => Promise<
    Array<
      [SignedActionHashed<CreateLink>, Array<SignedActionHashed<DeleteLink>>]
    >
  >,
  linkType: LinkTypeForSignal<S>,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): AsyncSignal<
  Array<[SignedActionHashed<CreateLink>, Array<SignedActionHashed<DeleteLink>>]>
> {
  let innerBaseAddress = baseAddress;
  if (getHashType(innerBaseAddress) === HashType.AGENT) {
    innerBaseAddress = retype(innerBaseAddress, HashType.ENTRY) as BASE;
  }

  let active = false;
  let unsubs: () => void | undefined;
  let deletedLinks:
    | Array<
        [SignedActionHashed<CreateLink>, Array<SignedActionHashed<DeleteLink>>]
      >
    | undefined;
  const signal = new Signal.State<
    AsyncResult<
      Array<
        [SignedActionHashed<CreateLink>, Array<SignedActionHashed<DeleteLink>>]
      >
    >
  >(
    { status: "pending" },
    {
      [Signal.subtle.watched]: () => {
        active = true;

        const maybeSet = (
          newDeletedLinks: Array<
            [
              SignedActionHashed<CreateLink>,
              Array<SignedActionHashed<DeleteLink>>,
            ]
          >,
        ) => {
          if (!active) return;

          const orderedNewLinks = newDeletedLinks.sort(
            sortDeletedLinksByTimestampAscending,
          );

          for (let i = 0; i < orderedNewLinks.length; i += 1) {
            orderedNewLinks[i][1] = orderedNewLinks[i][1].sort(
              sortActionsByTimestampAscending,
            );
            if (
              deletedLinks !== undefined &&
              (!deletedLinks[i] ||
                !areArrayHashesEqual(
                  orderedNewLinks[i][1].map((d) => d.hashed.hash),
                  deletedLinks[i][1].map((d) => d.hashed.hash),
                ))
            )
              return;
          }
          if (
            !deletedLinks ||
            !areArrayHashesEqual(
              orderedNewLinks.map((l) => l[0].hashed.hash),
              deletedLinks.map((l) => l[0].hashed.hash),
            )
          ) {
            deletedLinks = orderedNewLinks;
            signal.set({
              status: "completed",
              value: deletedLinks,
            });
          }
        };
        const fetch = async () => {
          if (!active) return;
          const ndeletedLinks = await fetchDeletedLinks().finally(() => {
            if (active) {
              setTimeout(() => fetch(), pollIntervalMs);
            }
          });
          maybeSet(ndeletedLinks);
        };
        fetch().catch((error) => {
          signal.set({
            status: "error",
            error,
          });
        });
        unsubs = client.onSignal((originalSignal) => {
          if (!(originalSignal as ActionCommittedSignal<any, any>).type) return;
          const hcSignal = originalSignal as ActionCommittedSignal<any, any>;

          if (hcSignal.type === "LinkDeleted") {
            if (
              linkType === hcSignal.link_type &&
              encodeHashToBase64(
                hcSignal.create_link_action.hashed.content.base_address,
              ) === encodeHashToBase64(innerBaseAddress)
            ) {
              const lastDeletedLinks = deletedLinks ? deletedLinks : [];
              const alreadyDeletedTargetIndex = lastDeletedLinks.findIndex(
                ([cl]) =>
                  encodeHashToBase64(cl.hashed.hash) ===
                  encodeHashToBase64(hcSignal.create_link_action.hashed.hash),
              );

              if (alreadyDeletedTargetIndex !== -1) {
                if (
                  !lastDeletedLinks[alreadyDeletedTargetIndex][1].find(
                    (dl) =>
                      encodeHashToBase64(dl.hashed.hash) ===
                      encodeHashToBase64(hcSignal.action.hashed.hash),
                  )
                ) {
                  const clone = cloneDeep(deletedLinks);
                  clone[alreadyDeletedTargetIndex][1].push(hcSignal.action);
                  maybeSet(clone);
                }
              } else {
                maybeSet([
                  ...lastDeletedLinks,
                  [hcSignal.create_link_action, [hcSignal.action]],
                ]);
              }
            }
          }
        });
      },
      [Signal.subtle.unwatched]: () => {
        signal.set({
          status: "pending",
        });
        active = false;
        deletedLinks = undefined;
        unsubs();
      },
    },
  );

  return signal;
}

// Keeps an up to date list of the entries in the agent's source chain for the given entry type
export function queryLiveEntriesSignal<
  T,
  S extends ActionCommittedSignal<any, any> & any,
>(
  client: ZomeClient<S>,
  queryEntries: () => Promise<Array<EntryRecord<T>>>,
  entry_type: string,
  pollIntervalMs: number = 20_000,
): AsyncSignal<Array<EntryRecord<T>>> {
  let active = false;
  let unsubs: () => void | undefined;
  let queriedEntries: Array<EntryRecord<T>> | undefined;
  const signal = new Signal.State<AsyncResult<Array<EntryRecord<T>>>>(
    { status: "pending" },
    {
      [Signal.subtle.watched]: () => {
        active = true;
        const fetch = async () => {
          if (!active) return;

          const nQueriedEntries = await queryEntries().finally(() => {
            if (active) {
              setTimeout(() => fetch(), pollIntervalMs);
            }
          });
          if (
            queriedEntries === undefined ||
            !areArrayHashesEqual(
              queriedEntries.map((r) => r.actionHash),
              nQueriedEntries.map((r) => r.actionHash),
            )
          ) {
            queriedEntries = nQueriedEntries;
            signal.set({
              status: "completed",
              value: queriedEntries,
            });
          }
        };
        fetch().catch((error) => {
          signal.set({
            status: "error",
            error,
          });
        });
        unsubs = client.onSignal(async (originalSignal) => {
          if (!active) return;
          if (!(originalSignal as ActionCommittedSignal<any, any>).type) return;
          const hcSignal = originalSignal as ActionCommittedSignal<any, any>;

          if (
            hcSignal.type === "EntryCreated" &&
            hcSignal.app_entry.type === entry_type
          ) {
            const newEntry = new EntryRecord<T>({
              entry: {
                Present: {
                  entry_type: "App",
                  entry: encode(hcSignal.app_entry),
                },
              },
              signed_action: hcSignal.action,
            });
            if (!queriedEntries) queriedEntries = [];
            queriedEntries.push(newEntry);
            signal.set({
              status: "completed",
              value: queriedEntries,
            });
          } else if (hcSignal.type === "EntryDeleted") {
            if (
              queriedEntries?.find(
                (e) =>
                  encodeHashToBase64(e.actionHash) ===
                  encodeHashToBase64(
                    hcSignal.action.hashed.content.deletes_address,
                  ),
              )
            ) {
              queriedEntries = queriedEntries.filter(
                (e) =>
                  encodeHashToBase64(e.actionHash) !==
                  encodeHashToBase64(
                    hcSignal.action.hashed.content.deletes_address,
                  ),
              );
              signal.set({
                status: "completed",
                value: queriedEntries,
              });
            }
          }
        });
      },
      [Signal.subtle.unwatched]: () => {
        signal.set({
          status: "pending",
        });
        active = false;
        queriedEntries = undefined;
        unsubs();
      },
    },
  );

  return signal;
}
