{
  inputs = {
    holonix.url = "github:holochain/holonix/main-0.5";
    holonix.inputs.playground.follows = "playground";
    nixpkgs.follows = "holonix/nixpkgs";
    crane.follows = "holonix/crane";

    holochain-nix-builders.url =
      "github:darksoil-studio/holochain-nix-builders/main-0.5";
    holochain-nix-builders.inputs.holonix.follows = "holonix";

    scaffolding.url = "github:darksoil-studio/scaffolding/main-0.5";
    scaffolding.inputs.holonix.follows = "holonix";
    scaffolding.inputs.holochain-nix-builders.follows =
      "holochain-nix-builders";

    tauri-plugin-holochain.url =
      "github:darksoil-studio/tauri-plugin-holochain/main-0.5";
    tauri-plugin-holochain.inputs.holonix.follows = "holonix";
    tauri-plugin-holochain.inputs.scaffolding.follows = "scaffolding";
    tauri-plugin-holochain.inputs.holochain-nix-builders.follows =
      "holochain-nix-builders";

    playground.url = "github:darksoil-studio/holochain-playground/main-0.5";
    playground.inputs.holonix.follows = "holonix";
    playground.inputs.scaffolding.follows = "scaffolding";
    playground.inputs.tauri-plugin-holochain.follows = "tauri-plugin-holochain";
  };

  nixConfig = {
    extra-substituters = [
      "https://holochain-ci.cachix.org"
      "https://darksoil-studio.cachix.org"
    ];
    extra-trusted-public-keys = [
      "holochain-ci.cachix.org-1:5IUSkZc0aoRS53rfkvH9Kid40NpyjwCMCzwRTXy+QN8="
      "darksoil-studio.cachix.org-1:UEi+aujy44s41XL/pscLw37KEVpTEIn8N/kn7jO8rkc="
    ];
  };

  outputs = inputs@{ ... }:
    inputs.holonix.inputs.flake-parts.lib.mkFlake { inherit inputs; } {

      systems = builtins.attrNames inputs.holonix.devShells;

      flake.flakeModules = {
        builders = inputs.holochain-nix-builders.outputs.flakeModules.builders;
        dependencies =
          inputs.holochain-nix-builders.outputs.flakeModules.dependencies;
      };
      imports = [
        inputs.holochain-nix-builders.outputs.flakeModules.builders
        inputs.holochain-nix-builders.outputs.flakeModules.dependencies
      ];

      perSystem = { inputs', self', config, pkgs, system, lib, ... }: {
        devShells.default = pkgs.mkShell {
          inputsFrom = [ inputs'.holonix.devShells.default ];
          packages = [ pkgs.pnpm ];
        };

        builders.rustZome = inputs'.holochain-nix-builders.builders.rustZome;
        builders.dna = inputs'.holochain-nix-builders.builders.dna;
        builders.happ = inputs'.holochain-nix-builders.builders.happ;
        builders.webhapp = inputs'.holochain-nix-builders.builders.webhapp;

        dependencies.holochain =
          inputs'.holochain-nix-builders.dependencies.holochain;

        devShells.synchronized-pnpm =
          inputs'.scaffolding.devShells.synchronized-pnpm;

        devShells.holochainDev =
          inputs'.holochain-nix-builders.devShells.holochainDev;

        packages = {
          holochain = inputs'.holochain-nix-builders.packages.holochain;

          hc-pilot = inputs'.tauri-plugin-holochain.packages.hc-pilot;
          hc-playground = inputs'.playground.packages.hc-playground;

          # Scaffolding
          hc-scaffold-app = inputs'.scaffolding.packages.hc-scaffold-happ;
          hc-scaffold-zome = inputs'.scaffolding.packages.hc-scaffold-zome;
          scaffold-remote-zome =
            inputs'.scaffolding.packages.scaffold-remote-zome;
        };
      };
    };
}
