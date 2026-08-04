import { marked } from "marked"
import { get } from "svelte/store"
import { activePopup, alertUpdates, isDev, popupData } from "./../stores"

interface UpdateData {
    latestVersion: string
    changelog: string
    hasUpdate: boolean
}

marked.setOptions({ breaks: true })

// GitHub release bodies are markdown, not the plain "hyphen -> bullet"
// text the old {@html changelog.replaceAll(...)} approach assumed - a
// real release commonly has headers, bold, links, and nested lists that
// were rendering as raw asterisks/hashes before this.
export function renderChangelogMarkdown(markdown: string): string {
    if (!markdown) return ""
    return marked.parse(markdown, { async: false }) as string
}

export async function getUpdateData(currentVersion: string): Promise<UpdateData> {
    // Repointed to this fork (vreykin/FreeShow, formerly Vitlyr/FreeShow -
    // the account/repo was renamed, see the commit that fixed this) -
    // checking upstream's repo would notify users about ChurchApps
    // releases that this fork's own version numbers/features have
    // diverged from.
    const response = await fetch("https://api.github.com/repos/vreykin/FreeShow/releases")
    const data = await response.json()

    // Only real, published releases - never a draft or a pre-release
    // (beta/rc/etc), regardless of whether the running version is itself
    // a beta. Previously this included pre-releases whenever the current
    // version had "-beta" in it or a "beta alerts" setting was on.
    const latestRelease = data.filter((a: any) => a.draft === false && a.prerelease === false)[0]

    const latestVersion = latestRelease?.tag_name?.slice(1) || ""
    const changelog = latestRelease?.body || ""

    return {
        latestVersion,
        changelog,
        hasUpdate: !!latestVersion && currentVersion !== latestVersion
    }
}

export function checkForUpdates(currentVersion: string) {
    if (get(isDev) || get(alertUpdates) === false) return

    getUpdateData(currentVersion)
        .then(({ latestVersion, changelog, hasUpdate }) => {
            if (get(activePopup) !== null) return
            if (!hasUpdate) return

            popupData.set({ changelog, latestVersion })
            activePopup.set("new_update")
        })
        .catch((error) => {
            console.warn(error)
        })
}
