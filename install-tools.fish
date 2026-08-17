#!/usr/bin/env fish

set -l red (set_color red)
set -l yellow (set_color yellow)
set -l green (set_color green)
set -l bold (set_color --bold)
set -l reset (set_color normal)

function info
  echo "$bold==>$reset $argv"
end

function warn
  echo "$yellow warning:$reset $argv"
end

function die
  echo "$red error:$reset $argv" >&2
  exit 1
end

function usage
  echo "Usage: fish install-tools.fish [options]"
  echo ""
  echo "  Download pinned client tools into tools/bin/ (gitignored)."
  echo "  Used from the client vantage, not from wormhole nodes."
  echo ""
  echo "  miniooni version: WORMHOLE_MINIOONI_VERSION in the environment, else .env"
  echo ""
  echo "Options:"
  echo "  -f, --force  Re-download even if tools/bin/miniooni is already current"
  echo "  -h, --help   Show this help"
end

function load_dotenv
  set -l env_file $argv[1]
  if not test -f $env_file
    return 0
  end

  while read -l line
    set line (string trim -- $line)
    if test -z "$line"; or string match -q '#*' -- $line
      continue
    end
    set line (string replace -r '^export\s+' '' -- $line)
    set -l matches (string match -r '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$' -- $line)
    if test (count $matches) -lt 3
      continue
    end
    set -l name $matches[2]
    set -l value (string trim -c '\'"' -- $matches[3])
    if not set -q $name; or test -z "$$name"
      set -gx $name $value
    end
  end <$env_file
end

function miniooni_asset
  set -l os (uname -s)
  set -l arch (uname -m)

  switch $os
    case Darwin
      switch $arch
        case arm64
          echo miniooni-darwin-arm64
        case x86_64
          echo miniooni-darwin-amd64
        case '*'
          return 1
      end
    case Linux
      switch $arch
        case x86_64 amd64
          echo miniooni-linux-amd64
        case aarch64 arm64
          echo miniooni-linux-arm64
        case armv7l
          echo miniooni-linux-armv7
        case armv6l
          echo miniooni-linux-armv6
        case '*'
          return 1
      end
    case '*'
      return 1
  end
end

function github_release_sha256
  set -l rel $argv[1]
  set -l asset $argv[2]
  set -l filter '.assets[] | select(.name == "'$asset'") | .digest | select(startswith("sha256:")) | ltrimstr("sha256:")'
  gh api repos/ooni/probe-cli/releases/tags/v$rel --jq $filter
end

function file_sha256
  if command -q shasum
    shasum -a 256 $argv[1] | string split -f 1 ' '
  else if command -q sha256sum
    sha256sum $argv[1] | string split -f 1 ' '
  else
    die "need shasum or sha256sum to verify the download"
  end
end

function installed_version
  set -l bin $argv[1]
  if not test -x $bin
    return 1
  end
  set -l out ($bin --version 2>/dev/null | string trim)
  if test -n "$out"
    printf '%s\n' $out
    return 0
  end
  return 1
end

function wait_for_binary
  set -l bin $argv[1]
  for attempt in 1 2 3 4 5
    set -l got (installed_version $bin)
    if test -n "$got"
      printf '%s\n' $got
      return 0
    end
    sleep 0.2
  end
  return 1
end

function install_miniooni
  set -l rel $argv[1]
  set -l force $argv[2]
  set -l dest tools/bin/miniooni
  set -l asset (miniooni_asset)
  or die "unsupported platform: "(uname -s)" "(uname -m)

  if test -x tools/miniooni; and not test -e $dest
    mkdir -p tools/bin
    or die "failed to create tools/bin/"
    mv -f tools/miniooni $dest
    or die "failed to move tools/miniooni to $dest"
  end

  if test $force -eq 0; and test -x $dest
    set -l current (installed_version $dest)
    if test "$current" = "$rel"
      echo "$green already installed$reset $dest ($rel)"
      return 0
    end
    if test -n "$current"
      warn "$dest is $current, expected $rel; re-downloading"
    end
  end

  info "Looking up SHA-256 for miniooni $rel ($asset)..."
  set -l expected_sha (github_release_sha256 $rel $asset)
  if test -z "$expected_sha"
    die "failed to read sha256 for $asset from GitHub release v$rel (check WORMHOLE_MINIOONI_VERSION)"
  end

  mkdir -p tools/bin
  or die "failed to create tools/bin/"

  set -l url https://github.com/ooni/probe-cli/releases/download/v$rel/$asset
  set -l tmp $dest.download

  info "Downloading miniooni $rel ($asset)..."
  curl -fL --progress-bar -A wormhole-install-tools -o $tmp $url
  or begin
    rm -f $tmp
    die "failed to download $url"
  end

  info "Verifying SHA-256..."
  set -l actual_sha (file_sha256 $tmp)
  if test "$actual_sha" != "$expected_sha"
    rm -f $tmp
    die "checksum mismatch for $asset (got $actual_sha)"
  end

  chmod +x $tmp
  or die "failed to chmod $tmp"

  if command -q xattr
    xattr -d com.apple.quarantine $tmp 2>/dev/null
  end

  mv -f $tmp $dest
  or die "failed to install $dest"

  set -l got (wait_for_binary $dest)
  if test -z "$got"
    $dest --version
    die "installed $dest but it did not run"
  end

  if test "$got" != "$rel"
    warn "binary reported version $got, expected $rel"
  end

  echo "$green installed$reset $dest ($got)"
end

# ── Args ───────────────────────────────────────────────────────────────────────

set -l force 0

for arg in $argv
  switch $arg
    case -h --help
      usage
      exit 0
    case -f --force
      set force 1
    case '*'
      usage
      echo ""
      die "unknown argument: $arg"
  end
end

# ── Repo root ──────────────────────────────────────────────────────────────────

builtin cd (status dirname)
or die "failed to change to the repository root"

if not command -q curl
  die "curl is required"
end

if not command -q gh
  die "gh is required to read GitHub release checksums"
end

# ── Version pin ────────────────────────────────────────────────────────────────

if not set -q WORMHOLE_MINIOONI_VERSION; or test -z "$WORMHOLE_MINIOONI_VERSION"
  load_dotenv .env
end

if not set -q WORMHOLE_MINIOONI_VERSION; or test -z "$WORMHOLE_MINIOONI_VERSION"
  die "WORMHOLE_MINIOONI_VERSION is unset; export it or add it to .env"
end

set -l miniooni_version (string trim -- $WORMHOLE_MINIOONI_VERSION)
set miniooni_version (string replace -r '^v' '' -- $miniooni_version)
if test -z "$miniooni_version"
  die "WORMHOLE_MINIOONI_VERSION is empty"
end

# ── Tools ──────────────────────────────────────────────────────────────────────

info "Installing client tools..."
install_miniooni $miniooni_version $force
or die "miniooni install failed"

echo ""
echo "$green$bold All done.$reset Client tools are in tools/bin/"
echo "      Check a site from this machine (not from wormhole nodes):"
echo ""
echo "        node scripts/check_site.mjs https://example.com/"
echo ""
