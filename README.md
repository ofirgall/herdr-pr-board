# herdr-pr-board

A [herdr](https://github.com/herdrdev/herdr) plugin that shows the open pull
requests of the repositories you choose, grouped by repository and colour-coded
by what each one is waiting on.

```
5 open · 1 stuck                            42s ago

herdr ───────────────────────── 3 · 1✗ 1✓ +1◌
  ogulcancelik #812 fix: pane focus…   ✓     ✓
  you          #809 feat: sidebar p…     ⚑2  ✗
◌ bob          #801 wip: windows co…         ●

dotfiles ───────────────────────────── none open
```

- The top line counts open pull requests and the ones **stuck** until their
  author acts (conflict, changes requested, failing checks or unresolved
  threads), and how old the data is. A failed refresh says why, in red, and
  the last good board stays up.
- Each repository heading counts its pull requests: stuck `✗`, waiting on a
  review `◆`, approved `✓`, and drafts `◌` apart.
- Each row is coloured by its loudest signal and ends with the status cluster
  shared with herdr-pr-tracker: conflict `⊘`, review, unresolved threads
  (`⚑` human, `⚐` bot) and checks.
- Click a pull request to open it, or a heading to open that repository's pull
  requests. Press `r` in the board to refresh.

All repositories are fetched in a single GitHub search per poll, through `gh`.

## Install

Requires [bun](https://bun.sh) and an authenticated [gh](https://cli.github.com).

```sh
herdr plugin install ofirgall/herdr-pr-board
```

## Configure

Copy `config.example` to `config` in the plugin's config directory and set
`REPOS`:

```sh
REPOS="herdrdev/herdr ofirgall/"
```

`owner/name` is one repository, shown even with nothing open. `owner/` is
every repository under an owner that has open pull requests. Bad entries are
counted on the board's last line and named on stderr.

## Show it

As a pane: run the plugin's `board` pane from herdr's plugin menu.

As a sidebar panel, on a herdr build with plugin panels:

```toml
[[panels]]
id = "prs"
plugin = "herdr-pr-board"
entrypoint = "board"

[ui.sidebar]
sections = ["spaces", "prs", "agents"]
```

The `refresh` action fetches the board now instead of waiting for the next
poll.

## Develop

```sh
bun install
bun test
bunx tsc --noEmit
```

## Credits

The signal rules, status cluster, click handling and much of the rendering are
taken from [herdr-pr-tracker](https://github.com/jakekroon/herdr-pr-tracker)
by Jake Kroon (MIT).
