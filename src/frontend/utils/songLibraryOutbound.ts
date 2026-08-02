// Outbound half of the Song Library live sync (see songLibraryClient.ts on
// the main-process side for inbound). Detects FreeShow-originated edits and
// relays them to the web app over the existing WebSocket connection via
// Main.SONG_LIBRARY_SYNC_OUTBOUND — the connection itself lives in the main
// process, so this module never talks to it directly, only through IPC.
//
// Detection strategy: subscribe to showsCache/shows/projects and diff each
// tick's content against the last-seen snapshot, rather than hooking every
// mutation call site across the app (history.ts, menuClick.ts, and dozens of
// component files all write to these stores directly) — far more robust to
// future refactors, at the cost of a JSON.stringify comparison per tick.
//
// Show.timestamps.modified and Project.modified are NOT reliably updated by
// FreeShow's own everyday edit paths (confirmed: nothing in the slide/box
// editors ever assigns timestamps.modified, and only some project mutations
// touch .modified) — cloud sync's syncManager.ts hits the same gap and
// works around it with its own setModifiedDate() fallback. Content changing
// is treated as the real signal here; the timestamp is stamped fresh at the
// moment a change is detected and sent, both for the outbound payload and
// written back into the local object, so it round-trips into something
// meaningful for the web app's own last-write-wins comparison.
import { Main } from "../../types/IPC/Main"
import type { Project, Projects } from "../../types/Projects"
import type { Show, Shows, TrimmedShows } from "../../types/Show"
import { sendMain } from "../IPC/main"
import { projects, shows, showsCache } from "../stores"
import { hasNewerUpdate } from "./common"

let started = false

// Main.SHOWS / Main.PROJECTS pushes (startup load, cloud sync, and this same
// sync feature's own inbound merge) apply main-authoritative data straight
// into these stores — never a reflection of a just-made local edit. Without
// this guard, an inbound update would look like a local change to the
// diffing below and get echoed straight back out — bookkeeping (lastSent/
// knownIds) still updates during an external tick, only the actual send is
// skipped, so a later unrelated local edit doesn't rediscover the inbound
// content as "changed" and echo it after the fact.
// [Main.SHOWS]'s handler is async (it may await loadShows() to pull newly-
// arrived shows' full content into showsCache before shows.set() runs) -
// the flag has to stay up for that whole awaited duration, not just the
// synchronous part, or the showsCache write it triggers slips through
// unguarded once the first `await` inside the handler yields.
let applyingExternal = false
export async function withExternalUpdate(fn: () => void | Promise<void>) {
    applyingExternal = true
    try {
        await fn()
    } finally {
        applyingExternal = false
    }
}

function sendOutbound(type: "song_upsert" | "song_delete" | "project_upsert" | "project_delete", payload: any) {
    sendMain(Main.SONG_LIBRARY_SYNC_OUTBOUND, { type, payload })
}

export function startSongLibraryOutbound() {
    if (started) return
    started = true

    watchShows()
    watchProjects()
}

function watchShows() {
    let lastSent: { [id: string]: string } = {}
    let knownIds: Set<string> | null = null

    showsCache.subscribe(async (cache: Shows) => {
        const external = applyingExternal
        if (!external && (await hasNewerUpdate("SONG_LIBRARY_OUTBOUND_SHOWS", 400))) return

        for (const id of Object.keys(cache)) {
            const show = cache[id]
            if (!show) continue

            const snapshot = JSON.stringify(show)
            if (lastSent[id] === snapshot) continue

            if (!external) {
                if (!show.timestamps) show.timestamps = { created: Date.now(), modified: null, used: null }
                show.timestamps.modified = Date.now()
            }

            lastSent[id] = JSON.stringify(show)
            if (!external) sendOutbound("song_upsert", { id, show: [id, show] })
        }
    })

    // Deletions: showsCache only ever grows (it's cleared/reset wholesale on
    // things like a project switch, not per-deletion), so the trimmed
    // `shows` store - the authoritative id list - is what actually reflects
    // a show going away.
    shows.subscribe((trimmed: TrimmedShows) => {
        const currentIds = new Set(Object.keys(trimmed))
        if (knownIds) {
            for (const id of knownIds) {
                if (currentIds.has(id)) continue
                delete lastSent[id]
                if (!applyingExternal) sendOutbound("song_delete", { id })
            }
        }
        knownIds = currentIds
    })
}

function watchProjects() {
    let lastSent: { [id: string]: string } = {}
    let knownIds: Set<string> | null = null

    projects.subscribe(async (all: Projects) => {
        const external = applyingExternal
        const currentIds = new Set(Object.keys(all))

        // Deletions always run synchronously, before the debounced upsert
        // scan below - otherwise a delete that lands during a debounce
        // window updates `knownIds` on a skipped tick without ever being
        // detected, and is lost for good (the next tick's diff finds
        // nothing changed, since knownIds already matches).
        if (knownIds) {
            for (const id of knownIds) {
                if (currentIds.has(id)) continue
                delete lastSent[id]
                if (!external) sendOutbound("project_delete", { id })
            }
        }
        knownIds = currentIds

        if (!external && (await hasNewerUpdate("SONG_LIBRARY_OUTBOUND_PROJECTS", 400))) return

        for (const id of currentIds) {
            const project: Project = all[id]
            if (!project) continue

            const snapshot = JSON.stringify(project)
            if (lastSent[id] === snapshot) continue

            if (!external) project.modified = Date.now()

            lastSent[id] = JSON.stringify(project)
            if (!external) sendOutbound("project_upsert", { id, project })
        }
    })
}
