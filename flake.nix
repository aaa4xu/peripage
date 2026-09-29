{
  description = "PeriPage.js development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "aarch64-darwin" "aarch64-linux" "x86_64-linux" ];
    in
    {
      devShells = nixpkgs.lib.genAttrs systems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = [ pkgs.bun pkgs.gh ];
          };

          # Firmware research: download and inspect images, apps, and installers.
          firmware = pkgs.mkShell {
            packages = [
              pkgs.curl
              pkgs.file
              pkgs.innoextract
              pkgs.jadx
              pkgs.openssl
              (pkgs.python3.withPackages (python: [
                python.androguard
                python.capstone
                python.unicorn
              ]))
              pkgs.unzip
            ];
          };
        });
    };
}
