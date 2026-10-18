# Source control

T3 Code opens, lists and checks out pull requests through each host's own
command-line tool, which it looks for on `PATH` and asks whether it is signed in
(Settings → Source Control in T3 Code). The setup page's **Source control**
page (under **More** on a phone) has one row per host:

| Host | CLI | In the image | Signs in with |
| --- | --- | :---: | --- |
| GitHub | `gh` | ✅ | a device code, or a token |
| GitLab | `glab` | one click | a token |
| Forgejo (Codeberg) | `fj` | one click | a token |
| Gitea (and Forgejo) | `tea` | one click | a token |
| Azure DevOps | `az`, with the `azure-devops` extension | one click | a device code |

Bitbucket needs no CLI: T3 Code talks to its API with a token you add in T3
Code's own Settings → Source Control.

`glab`, `fj`, `tea` and `az` install like a toolchain: into the volume through
mise, at an exact version, one press to update or remove. None of them installs
on its own, because which host a server talks to can't be guessed and the Azure
CLI alone takes about 330 MB; `T3_PREINSTALL=default,source-control` (or a
list such as `default,glab,az`) installs them on the first start along with the
usual set. A CLI you already added as a tool of your own (`azure-cli`, say) is
used as it is, and never installed a second time. `az` comes with the `azure-devops`
extension, which T3 Code needs to reach repositories; a row whose extension has
gone missing offers **Repair**.

Each row says who the CLI is signed in as, the same way T3 Code asks. One you
installed and haven't signed in counts as needing you, since T3 Code can't use
it yet; the image's `gh` never does. **Sign in** opens a sheet:

- **gh and az**: a device code, like the agents': open github.com's or
  Microsoft's page on any device, enter the code, approve. There is no token to
  make. `gh` asks for the `workflow` scope on top of its own, so T3 Code can
  push a branch that changes `.github/workflows`.
- **glab, fj, tea**, and **gh** with a token (its row's menu, for GitHub
  Enterprise or a narrower token): name the server (gitlab.com, codeberg.org
  and gitea.com unless yours runs elsewhere), open its token page, which links
  to a new token with the scopes T3 Code needs where the host allows that, and
  paste the token. It goes to the CLI on stdin (to `tea` in its environment),
  never as an argument, and the server has to accept it before the sheet
  closes. A token it refused leaves things as they were: a sign-in that worked
  before is still there.

`gh` and `tea` also become git's credential helper for the server they sign in
to, so a push over HTTPS uses the same sign-in. Once signed in, the row's menu
signs in again, to another server, or out. From a shell:

```bash
docker compose exec t3code t3-harness source-control     # every CLI, its host and who it is signed in as
docker compose exec t3code t3-harness install glab
docker compose exec -u t3 -it t3code bash -lc 'glab auth login'   # or any CLI's own sign-in
```

Sign-ins are kept on the state volume like the agents', and so is
`~/.gitconfig` with the credential helpers (see
[Configuration](configuration.md)), so both survive a recreate.
