import { createMemo, For, Match, Switch } from "solid-js"
import { Button } from "@bountyreaper-io/ui/button"
import { Logo } from "@bountyreaper-io/ui/logo"
import { useLayout } from "@/context/layout"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@bountyreaper-io/util/encode"
import { Icon } from "@bountyreaper-io/ui/icon"
import { usePlatform } from "@/context/platform"
import { DateTime } from "luxon"
import { useDialog } from "@bountyreaper-io/ui/context/dialog"
import { DialogSelectDirectory } from "@/components/dialog-select-directory"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { useServer } from "@/context/server"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"

export default function Home() {
  const sync = useGlobalSync()
  const layout = useLayout()
  const platform = usePlatform()
  const dialog = useDialog()
  const navigate = useNavigate()
  const server = useServer()
  const language = useLanguage()
  const homedir = createMemo(() => sync.data.path.home)
  const recent = createMemo(() => {
    return sync.data.project
      .slice()
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .slice(0, 5)
  })

  const serverDotClass = createMemo(() => {
    const healthy = server.healthy()
    if (healthy === true) return "bg-icon-success-base"
    if (healthy === false) return "bg-icon-critical-base"
    return "bg-border-weak-base"
  })

  function openProject(directory: string) {
    layout.projects.open(directory)
    server.projects.touch(directory)
    navigate(`/${base64Encode(directory)}`)
  }

  async function chooseProject() {
    function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        for (const directory of result) {
          openProject(directory)
        }
      } else if (result) {
        openProject(result)
      }
    }

    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform.openDirectoryPickerDialog?.({
        title: language.t("command.project.open"),
        multiple: true,
      })
      resolve(result)
    } else {
      dialog.show(
        () => <DialogSelectDirectory multiple={true} onSelect={resolve} />,
        () => resolve(null),
      )
    }
  }

  const stats = createMemo(() => {
    const projects = sync.data.project.length
    const recentCount = recent().length
    return { sessions: recentCount, projects, vulns: 0, allSessions: recentCount }
  })

  return (
    <div class="mx-auto w-full max-w-6xl px-6 py-8">
      <div class="flex items-center justify-between">
        <Logo class="opacity-12 w-32" />
        <Button
          size="normal"
          variant="ghost"
          class="text-12-regular text-text-weak"
          onClick={() => dialog.show(() => <DialogSelectServer />)}
        >
          <div
            classList={{
              "size-2 rounded-full": true,
              [serverDotClass()]: true,
            }}
          />
          {server.name}
        </Button>
      </div>

      {/* Artex-style dashboard stats */}
      <div class="mt-8 grid grid-cols-1 md:grid-cols-4 gap-4">
        <div class="rounded-lg border border-border-weak bg-background-weak p-4">
          <div class="text-12-regular text-text-weak">Active Sessions</div>
          <div class="text-24-medium text-text-strong mt-1">{stats().sessions}</div>
          <div class="text-12-regular text-text-weak mt-1">{stats().allSessions} total including subagents</div>
        </div>
        <div class="rounded-lg border border-border-weak bg-background-weak p-4">
          <div class="text-12-regular text-text-weak">Vulnerabilities</div>
          <div class="text-24-medium text-text-strong mt-1">{stats().vulns}</div>
          <div class="text-12-regular text-text-weak mt-1">Across all projects</div>
        </div>
        <div class="rounded-lg border border-border-weak bg-background-weak p-4">
          <div class="text-12-regular text-text-weak">Projects</div>
          <div class="text-24-medium text-text-strong mt-1">{stats().projects}</div>
          <div class="text-12-regular text-text-weak mt-1">Workspaces tracked</div>
        </div>
        <div class="rounded-lg border border-border-weak bg-background-weak p-4">
          <div class="text-12-regular text-text-weak">Status</div>
          <div class="text-14-medium text-text-strong mt-2 flex items-center gap-2">
            <div classList={{ "size-2 rounded-full": true, [serverDotClass()]: true }} />
            {server.healthy() === true ? "Connected" : server.healthy() === false ? "Disconnected" : "Connecting"}
          </div>
        </div>
      </div>
      <Switch>
        <Match when={sync.data.project.length > 0}>
          <div class="mt-20 w-full flex flex-col gap-4">
            <div class="flex gap-2 items-center justify-between pl-3">
              <div class="text-14-medium text-text-strong">{language.t("home.recentProjects")}</div>
              <Button icon="folder-add-left" size="normal" class="pl-2 pr-3" onClick={chooseProject}>
                {language.t("command.project.open")}
              </Button>
            </div>
            <ul class="flex flex-col gap-2">
              <For each={recent()}>
                {(project) => (
                  <Button
                    size="large"
                    variant="ghost"
                    class="text-14-mono text-left justify-between px-3"
                    onClick={() => openProject(project.worktree)}
                  >
                    {project.worktree.replace(homedir(), "~")}
                    <div class="text-14-regular text-text-weak">
                      {DateTime.fromMillis(project.time.updated ?? project.time.created).toRelative()}
                    </div>
                  </Button>
                )}
              </For>
            </ul>
          </div>
        </Match>
        <Match when={true}>
          <div class="mt-30 mx-auto flex flex-col items-center gap-3">
            <Icon name="folder-add-left" size="large" />
            <div class="flex flex-col gap-1 items-center justify-center">
              <div class="text-14-medium text-text-strong">{language.t("home.empty.title")}</div>
              <div class="text-12-regular text-text-weak">{language.t("home.empty.description")}</div>
            </div>
            <Button class="px-3 mt-1" onClick={chooseProject}>
              {language.t("command.project.open")}
            </Button>
          </div>
        </Match>
      </Switch>
    </div>
  )
}
