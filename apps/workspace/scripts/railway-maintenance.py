"""Run a reviewed SQL plan against STJW's separate PostgreSQL container.

Credentials remain in the database container. The OpenSSH identity is used only
by OpenSSH. No database password or connection URL is read or printed here.
"""
from pathlib import Path
import argparse, re, subprocess, sys

parser=argparse.ArgumentParser()
parser.add_argument('--config',required=True)
parser.add_argument('--identity-file',required=True)
parser.add_argument('--known-hosts',required=True)
parser.add_argument('--sql',required=True)
parser.add_argument('--dry-run',action='store_true')
args=parser.parse_args()
config=Path(args.config).read_text(encoding='utf-8-sig')
match=re.search(r'^\s*User ([a-f0-9-]+)$',config,re.M)
if not match: raise SystemExit('Expected the reviewed Railway PostgreSQL SSH configuration.')
sql=Path(args.sql).read_text(encoding='utf-8-sig')
if args.dry_run:
    if sql.count('\nCOMMIT;\n')!=1: raise SystemExit('Expected exactly one maintenance transaction commit.')
    sql=sql.replace('\nCOMMIT;\n','\nROLLBACK;\n').replace("'maintenance_complete'","'maintenance_dry_run'")
ssh=['C:/Windows/System32/OpenSSH/ssh.exe','-o','BatchMode=yes','-o','ConnectTimeout=15','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(Path(args.known_hosts).resolve()),'-i',str(Path(args.identity_file).resolve()),'-T',match.group(1)+'@ssh.railway.com','psql -X --username="$PGUSER" --dbname="$PGDATABASE" --quiet --set=ON_ERROR_STOP=1 --file=-']
result=subprocess.run(ssh,input=sql,capture_output=True,text=True,encoding='utf-8',timeout=120)
sys.stdout.write(result.stdout)
sys.stderr.write(result.stderr)
raise SystemExit(result.returncode)
