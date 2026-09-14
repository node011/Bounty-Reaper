{
  lib,
  stdenvNoCC,
  callPackage,
  bun,
  sysctl,
  makeBinaryWrapper,
  models-dev,
  ripgrep,
  installShellFiles,
  versionCheckHook,
  writableTmpDirAsHomeHook,
  node_modules ? callPackage ./node-modules.nix { },
}:
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "bountyreaper";
  inherit (node_modules) version src;
  inherit node_modules;

  nativeBuildInputs = [
    bun
    installShellFiles
    makeBinaryWrapper
    models-dev
    writableTmpDirAsHomeHook
  ];

  configurePhase = ''
    runHook preConfigure

    cp -R ${finalAttrs.node_modules}/. .

    runHook postConfigure
  '';

  env.MODELS_DEV_API_JSON = "${models-dev}/dist/_api.json";
  env.BOUNTYREAPER_DISABLE_MODELS_FETCH = true;
  env.BOUNTYREAPER_VERSION = finalAttrs.version;
  env.BOUNTYREAPER_CHANNEL = "local";

  buildPhase = ''
    runHook preBuild

    cd ./packages/bountyreaper
    bun --bun ./script/build.ts --single --skip-install
    bun --bun ./script/schema.ts schema.json

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    install -Dm755 dist/bountyreaper-*/bin/bountyreaper $out/bin/bountyreaper
    install -Dm644 schema.json $out/share/bountyreaper/schema.json

    wrapProgram $out/bin/bountyreaper \
      --prefix PATH : ${
        lib.makeBinPath (
          [
            ripgrep
          ]
          # bun runs sysctl to detect if dunning on rosetta2
          ++ lib.optional stdenvNoCC.hostPlatform.isDarwin sysctl
        )
      }

    runHook postInstall
  '';

  postInstall = lib.optionalString (stdenvNoCC.buildPlatform.canExecute stdenvNoCC.hostPlatform) ''
    # trick yargs into also generating zsh completions
    installShellCompletion --cmd bountyreaper \
      --bash <($out/bin/bountyreaper completion) \
      --zsh <(SHELL=/bin/zsh $out/bin/bountyreaper completion)
  '';

  nativeInstallCheckInputs = [
    versionCheckHook
    writableTmpDirAsHomeHook
  ];
  doInstallCheck = true;
  versionCheckKeepEnvironment = [ "HOME" "BOUNTYREAPER_DISABLE_MODELS_FETCH" ];
  versionCheckProgramArg = "--version";

  passthru = {
    jsonschema = "${placeholder "out"}/share/bountyreaper/schema.json";
  };

  meta = {
    description = "The open source coding agent";
    homepage = "https://bountyreper.io/";
    license = lib.licenses.mit;
    mainProgram = "bountyreaper";
    inherit (node_modules.meta) platforms;
  };
})
