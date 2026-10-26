import os
import sys
import tarfile
import subprocess
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

EXCLUDE_DIRS = {
    "node_modules",
    "__pycache__",
    ".git",
    "venv",
    ".venv",
    ".pytest_cache"
}

def make_tarball(output_filename="deploy_archive.tar.gz"):
    tar_path = BASE_DIR / output_filename
    print(f"[1/3] Packaging project into {output_filename}...")
    
    with tarfile.open(tar_path, "w:gz") as tar:
        for root, dirs, files in os.walk(BASE_DIR):
            # Prune excluded directories in-place
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
            
            for file in files:
                if file.endswith((".tar.gz", ".pyc", ".log", ".db", ".db-shm", ".db-wal")):
                    continue
                file_path = Path(root) / file
                rel_path = file_path.relative_to(BASE_DIR)
                tar.add(file_path, arcname=str(rel_path).replace("\\", "/"))

    size_mb = os.path.getsize(tar_path) / (1024 * 1024)
    print(f"    Archive created: {size_mb:.2f} MB")
    return tar_path

def sync_to_gcp():
    tar_path = make_tarball()
    
    gcp_key = os.getenv("GCP_SSH_KEY", os.path.expanduser("~/.ssh/id_rsa"))
    gcp_user = os.getenv("GCP_VM_USER", "ubuntu")
    gcp_ip = os.getenv("GCP_VM_IP", "YOUR_VM_IP")
    remote_dir = os.getenv("GCP_TARGET_DIR", f"/home/{gcp_user}/neotrader")

    print(f"[2/3] Uploading archive to VM ({gcp_user}@{gcp_ip}:{remote_dir}/)...")
    scp_upload_cmd = [
        "scp", "-i", gcp_key, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
        str(tar_path),
        f"{gcp_user}@{gcp_ip}:{remote_dir}/deploy_archive.tar.gz"
    ]
    res = subprocess.run(scp_upload_cmd)
    if res.returncode != 0:
        print("Archive scp upload failed.")
        sys.exit(res.returncode)

    print("[3/3] Extracting files, running migrations, and restarting neotrader.service...")
    ssh_restart_cmd = [
        "ssh", "-i", gcp_key, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
        f"{gcp_user}@{gcp_ip}",
        f"cd {remote_dir} && tar -xzf deploy_archive.tar.gz && rm deploy_archive.tar.gz && venv/bin/python -m backend.database && sudo systemctl restart neotrader.service && sudo systemctl status neotrader.service --no-pager"
    ]
    res2 = subprocess.run(ssh_restart_cmd)
    if res2.returncode != 0:
        print("Remote extraction or service restart failed.")
        sys.exit(res2.returncode)

    # Clean up local archive
    if tar_path.exists():
        tar_path.unlink()

    print("\n[SUCCESS] Successfully synced code to Google Cloud VM and restarted neotrader.service!")

if __name__ == "__main__":
    sync_to_gcp()
