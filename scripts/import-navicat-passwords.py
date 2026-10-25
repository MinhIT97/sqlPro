#!/usr/bin/env python3
"""Legacy entry point: count profiles without decrypting or exporting credentials.

Import connections through SqlPro's File menu using a Navicat .ncx/JSON export.
This diagnostic emits aggregate counts only, even when stdout is redirected.
"""

import json
import sys


def inventory_navicat(registry):
    counts = {"connections": 0, "with_database_credential": 0, "with_ssh_credential": 0}
    try:
        root = registry.OpenKey(registry.HKEY_CURRENT_USER, r"Software\PremiumSoft\Navicat\Servers")
    except FileNotFoundError:
        return counts
    with root:
        for index in range(registry.QueryInfoKey(root)[0]):
            name = registry.EnumKey(root, index)
            with registry.OpenKey(root, name) as profile:
                database_present = False
                ssh_present = False
                for position in range(registry.QueryInfoKey(profile)[1]):
                    field, value, _ = registry.EnumValue(profile, position)
                    # Count presence without decoding, rendering or retaining the value.
                    if field in ("Pwd", "Pwd_2") and value:
                        database_present = True
                    if field in ("SSH_Password", "SSH_Password_2") and value:
                        ssh_present = True
                counts["connections"] += 1
                counts["with_database_credential"] += int(database_present)
                counts["with_ssh_credential"] += int(ssh_present)
    return counts


def main(argv=None, registry=None):
    arguments = sys.argv[1:] if argv is None else argv
    if arguments:
        # Do not echo unknown arguments: they may contain secrets.
        sys.stderr.write("No export options are supported. Import .ncx/JSON through SqlPro's File menu.\n")
        return 2
    try:
        if registry is None:
            import winreg as registry
        counts = inventory_navicat(registry)
    except Exception:
        # Exceptions from OS/dependencies can contain profile data; never print them.
        sys.stderr.write("Navicat inventory unavailable. No credentials were exported.\n")
        return 1
    sys.stdout.write(json.dumps(counts) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
