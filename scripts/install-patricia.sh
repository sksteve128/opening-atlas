#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
target=.engines/patricia-5.1
revision=f1ee4273c6e6068bd6ec0d53ca91c1c391543f85
if [ ! -d "$target" ]; then
  git clone --depth 1 --branch 5.1 https://github.com/Adam-Kulju/Patricia "$target"
fi
[ "$(git -C "$target" rev-parse HEAD)" = "$revision" ] || { echo 'Unexpected Patricia revision'; exit 1; }
[ -z "$(git -C "$target" status --porcelain --untracked-files=no)" ] || { echo 'Patricia source has local modifications'; exit 1; }
make -C "$target/engine" build
file "$target/engine/patricia"
printf 'uci\nisready\nquit\n' | "$target/engine/patricia"
