# Homebrew formula for the Kash CLI.
#
# Lives in this repo as the source-of-truth template; the actual formula
# lands in the public tap repository (KashDAO/homebrew-tap) on each
# release. The release workflow updates `url` (the npm tarball) and
# `sha256` from the just-published artefact.
#
# Install:
#   brew tap kashdao/tap
#   brew install kash
#
# Why a Node-package formula (not a static binary):
#   - The CLI is small and Node 22+ is already a dependency of most
#     developer environments. A static binary build adds release
#     surface (per-platform builds) without unlocking a new audience.
#   - Homebrew's `Language::Node` helpers handle `npm install`, prefix
#     management, and stdlib lookup — the formula is ~10 lines of glue.
#
# Replace tokens before publishing:
#   __VERSION__       — semver of the published @kashdao/cli release
#   __TARBALL_SHA__   — sha256 of the npm tarball at __VERSION__

class Kash < Formula
  desc "Official command-line interface for the Kash public API"
  homepage "https://github.com/KashDAO/cli"
  url "https://registry.npmjs.org/@kashdao/cli/-/cli-__VERSION__.tgz"
  sha256 "__TARBALL_SHA__"
  license "MIT"

  # Node 22 is the floor — older runtimes will fail at first command.
  depends_on "node@22"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/kash"]
  end

  def caveats
    <<~CAVEATS
      Tab completion (bash / zsh / fish):
        kash completion install

      Save your API key:
        kash auth set-key kash_live_…

      Docs and examples:
        https://github.com/KashDAO/cli#readme
    CAVEATS
  end

  test do
    # `--version` exits 0 with the package version printed to stdout.
    # The release workflow's `__VERSION__` substitution makes this an
    # end-to-end check that the published tarball matches the formula.
    assert_match version.to_s, shell_output("#{bin}/kash --version")
  end
end
