// Live sync client connecting out to the Song Library web app's WebSocket
// server at /api/sync (see that project's lib/syncServer.js for the wire
// protocol this speaks — JSON envelopes {v:1, type, payload} with hello,
// full_sync_request, full_sync, song_upsert, song_delete, project_upsert,
// project_delete messages).
//
// Inbound only for now: applies web-app-originated changes to the local
// SHOWS/PROJECTS stores and pushes them into the renderer via the same
// sendMain(Main.SHOWS, ...) / sendMain(Main.PROJECTS, ...) calls the
// existing cloud sync (syncManager.ts) already uses. Outbound (pushing a
// FreeShow-originated edit back to the web app) is a separate, later step.
//
// Conflict resolution: last-write-wins by `timestamps.modified` (songs) or
// `modified` (projects) — an incoming update that isn't strictly newer than
// what's already on disk is dropped. This also prevents echo loops, since
// the web app never rebroadcasts a change back to the connection that sent
// it, but a plain full_sync on (re)connect could otherwise re-apply
// something already applied.
import path from "path"
import WebSocket from "ws"
import { Main } from "../../types/IPC/Main"
import type { Folders, Project, Projects } from "../../types/Projects"
import type { Show } from "../../types/Show"
import { _store, getStore, safeStoreSet } from "../data/store"
import { sendMain } from "../IPC/main"
import { deleteFileAsync, doesPathExist, getDataFolderPath, loadShows, writeFileAsync } from "../utils/files"

type SyncConfig = { enabled: boolean; ip: string; port: number }
type Envelope = { v: number; type: string; payload: any }

let ws: WebSocket | null = null
let config: SyncConfig | null = null
let manuallyClosed = true
let reconnectTimer: NodeJS.Timeout | null = null
let reconnectDelay = 1000
const MAX_RECONNECT_DELAY = 30000

export function updateSongLibrarySync(data: SyncConfig) {
    const sameTarget = config?.enabled && config.ip === data.ip && config.port === data.port

    if (!data.enabled) {
        config = data
        disconnect()
        return
    }

    if (sameTarget && (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING)) {
        // already connected/connecting to this exact target - nothing to do
        config = data
        return
    }

    config = data
    disconnect()
    manuallyClosed = false
    reconnectDelay = 1000
    connect()
}

function disconnect() {
    manuallyClosed = true
    if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
    }
    if (ws) {
        ws.removeAllListeners()
        try {
            ws.close()
        } catch {
            // ignore
        }
        ws = null
    }
}

function connect() {
    if (!config?.enabled) return

    // Node on Windows can take ~20-30s to resolve the hostname "localhost"
    // (it tries the IPv6 ::1 route first, then falls back to IPv4 after a
    // long OS-level timeout) - macOS/Linux resolve it instantly. Using the
    // literal loopback address skips hostname resolution entirely.
    const host = config.ip === "localhost" ? "127.0.0.1" : config.ip
    const url = `ws://${host}:${config.port}/api/sync`
    console.log(`songLibraryClient: connecting to ${url}`)

    const socket = new WebSocket(url)
    ws = socket

    socket.on("open", () => {
        console.log("songLibraryClient: connected")
        reconnectDelay = 1000
        send(socket, "hello", { client: "freeshow" })
        send(socket, "full_sync_request", {})
    })

    socket.on("message", (raw: Buffer | string) => {
        let msg: Envelope
        try {
            msg = JSON.parse(raw.toString())
        } catch {
            return
        }
        handleMessage(msg).catch((err) => console.error("songLibraryClient: error handling message:", err.message))
    })

    socket.on("close", () => {
        if (ws !== socket) return // superseded by a newer connection
        console.log("songLibraryClient: disconnected")
        ws = null
        scheduleReconnect()
    })

    socket.on("error", (err: Error) => {
        console.error("songLibraryClient: connection error:", err.message)
    })
}

function scheduleReconnect() {
    if (manuallyClosed || !config?.enabled) return
    if (reconnectTimer) return

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect()
    }, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
}

function send(socket: WebSocket, type: string, payload: any) {
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ v: 1, type, payload }))
}

// Called by the IPC handler for Main.SONG_LIBRARY_SYNC_OUTBOUND (see
// responsesMain.ts) — a FreeShow-originated edit, detected by the renderer's
// songLibraryOutbound.ts, forwarded here to go out over the current
// connection. A silent no-op while disconnected/disabled, same as any other
// send() call — the web app is the source of truth, so a change made while
// disconnected simply stays local until the next edit is made while
// connected (full two-way reconciliation on reconnect is a later step).
export function sendOutbound(type: string, payload: any) {
    if (!ws) return
    send(ws, type, payload)
}

async function handleMessage(msg: Envelope) {
    if (!msg || typeof msg.type !== "string") return
    switch (msg.type) {
        case "full_sync":
            return handleFullSync(msg.payload)
        case "song_upsert":
            return handleSongUpsert(msg.payload)
        case "song_delete":
            return handleSongDelete(msg.payload)
        case "project_upsert":
            return handleProjectUpsert(msg.payload)
        case "project_delete":
            return handleProjectDelete(msg.payload)
    }
}

// ----- SONGS -----

function localShowModified(id: string): number {
    return getStore("SHOWS")[id]?.timestamps?.modified || 0
}

// Async (writeFileAsync/deleteFileAsync, not the sync writeFile/deleteFile
// used elsewhere in this file) specifically because handleFullSync below
// calls this once per song, and a full sync can be thousands of songs.
// Synchronous fs calls in that loop blocked the main process's event loop
// for the entire loop's duration - reported as the whole app freezing for
// ~30s on Windows on every reconnect (Defender's real-time scanning
// intercepts every single file write, which adds up fast over thousands of
// files; macOS has no equivalent per-write interception, so the same loop
// there was fast enough to go unnoticed). await-ing each write yields the
// event loop between songs so the app stays responsive throughout, even
// though the sync itself still takes real wall-clock time.
async function writeShowFile(id: string, show: Show) {
    const showsPath = getDataFolderPath("shows")
    const oldName = getStore("SHOWS")[id]?.name
    const fileName = String(show.name || id) + ".show"

    if (oldName && oldName + ".show" !== fileName) {
        const oldPath = path.join(showsPath, oldName + ".show")
        if (doesPathExist(oldPath)) await deleteFileAsync(oldPath)
    }

    await writeFileAsync(path.join(showsPath, fileName), JSON.stringify([id, show]), id)
}

async function applySongUpsert(id: string, show: Show): Promise<boolean> {
    if (!id || !show) return false
    if ((show.timestamps?.modified || 0) <= localShowModified(id)) return false // stale or an echo of our own change
    await writeShowFile(id, show)
    return true
}

async function handleSongUpsert(payload: { id: string; show: [string, Show] }) {
    if (!payload || !Array.isArray(payload.show)) return
    const [id, show] = payload.show
    if (!(await applySongUpsert(id, show))) return

    await refreshShows([show.name])
}

async function handleSongDelete(payload: { id: string }) {
    if (!payload?.id) return
    const local = getStore("SHOWS")[payload.id]
    if (!local) return

    const showsPath = getDataFolderPath("shows")
    const filePath = path.join(showsPath, local.name + ".show")
    if (doesPathExist(filePath)) await deleteFileAsync(filePath)

    await refreshShows([])
}

// loadShows() itself is synchronous (a single call blocks for its entire
// duration, same class of problem as the writes above) and, per song
// actually being refreshed, re-reads and re-parses that file from disk even
// though we already have its full content in memory from this same
// full_sync payload — necessary because it also rebuilds the trimmed
// metadata cache other parts of the app read, which this module has no
// other way to update. Calling it in small batches with a yield between
// each keeps any single blocking call short instead of one call blocking
// for the size of the entire changed set.
const REFRESH_BATCH_SIZE = 100

async function refreshShows(changedNames: string[]) {
    for (let i = 0; i < changedNames.length; i += REFRESH_BATCH_SIZE) {
        loadShows(false, changedNames.slice(i, i + REFRESH_BATCH_SIZE))
        await new Promise((resolve) => setImmediate(resolve))
    }
    if (_store.SHOWS) sendMain(Main.SHOWS, _store.SHOWS.store)
}

// ----- PROJECTS -----

function currentProjectsData() {
    return getStore("PROJECTS") as { projects: Projects; folders: Folders; projectTemplates: Projects }
}

async function handleProjectUpsert(payload: { id: string; project: Project }) {
    if (!payload?.id || !payload.project) return
    const data = currentProjectsData()
    const local = data.projects[payload.id]
    if ((payload.project.modified || 0) <= (local?.modified || 0)) return

    data.projects[payload.id] = payload.project
    await safeStoreSet(_store.PROJECTS, data, "PROJECTS")
    sendMain(Main.PROJECTS, data)
}

async function handleProjectDelete(payload: { id: string }) {
    if (!payload?.id) return
    const data = currentProjectsData()
    if (!data.projects[payload.id]) return

    delete data.projects[payload.id]
    await safeStoreSet(_store.PROJECTS, data, "PROJECTS")
    sendMain(Main.PROJECTS, data)
}

// ----- FULL SYNC -----

async function handleFullSync(payload: { songs?: [string, Show][]; projects?: { projects: Projects; folders: Folders; projectTemplates: Projects } }) {
    // Timed explicitly (not just "did it freeze or not") so a slow full_sync
    // reported in the future points straight at which phase is actually
    // responsible instead of requiring another guess-fix-rebuild round trip.
    const totalSongs = payload?.songs?.length || 0
    const tWriteStart = Date.now()
    const changedNames: string[] = []
    for (const [id, show] of payload?.songs || []) {
        if (await applySongUpsert(id, show)) changedNames.push(show.name)
    }
    console.log(`songLibraryClient: full_sync wrote ${changedNames.length}/${totalSongs} songs in ${Date.now() - tWriteStart}ms`)

    if (changedNames.length) {
        const tRefreshStart = Date.now()
        await refreshShows(changedNames)
        console.log(`songLibraryClient: full_sync refreshed shows cache (${changedNames.length} names) in ${Date.now() - tRefreshStart}ms`)
    }

    if (payload?.projects) {
        const data = currentProjectsData()
        let changed = false

        for (const [id, project] of Object.entries(payload.projects.projects || {})) {
            const local = data.projects[id]
            if ((project.modified || 0) <= (local?.modified || 0)) continue
            data.projects[id] = project
            changed = true
        }

        // web app is the source of truth for folders/templates - no per-item
        // merge needed, unlike individual projects which might have a
        // pending unsynced local edit in the reconnect window
        data.folders = payload.projects.folders || data.folders
        data.projectTemplates = payload.projects.projectTemplates || data.projectTemplates
        changed = true

        if (changed) {
            await safeStoreSet(_store.PROJECTS, data, "PROJECTS")
            sendMain(Main.PROJECTS, data)
        }
    }
}
