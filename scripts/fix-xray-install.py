from pathlib import Path
import re
p = Path("/root/xray-install.sh")
t = p.read_text()
pat = (
    r"    public_key=\$\(echo \"\$key_output\" \| awk '/Password:/\{print \$2\}'\)\n"
    r"    \[\[ -z \"\$public_key\" \]\] && public_key=\$\(echo \"\$key_output\" \| awk '/Public key:/\{print \$3\}'\)"
)
repl = (
    "    public_key=$(echo \"$key_output\" | awk '/Password \\(PublicKey\\):/{print $3}')\n"
    "    [[ -z \"$public_key\" ]] && public_key=$(echo \"$key_output\" | awk '/^Password:/{print $2}')\n"
    "    [[ -z \"$public_key\" ]] && public_key=$(echo \"$key_output\" | awk '/Public key:/{print $3}')"
)
t2, n = re.subn(pat, repl, t, count=1)
print("patched", n)
if n != 1:
    i = t.find("public_key=")
    print(repr(t[i:i+300]))
    raise SystemExit(1)
p.write_text(t2)
