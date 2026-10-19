import os
import sys
import socket
import uvicorn

if sys.stdout.encoding.lower() != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

def get_local_ips():
    ips = []
    try:
        hostname = socket.gethostname()
        for ip in socket.gethostbyname_ex(hostname)[2]:
            if not ip.startswith("127."):
                ips.append(ip)
    except Exception:
        pass
    return ips

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8080))
    host = os.getenv("HOST", "0.0.0.0")
    
    local_ips = get_local_ips()
    
    print("==================================================================")
    print(">> Kotak Neo Nifty Trading Engine starting...")
    print(f">> Laptop (Localhost) : http://localhost:{port}")
    if local_ips:
        print(">> Mobile (Same Wi-Fi):")
        for ip in local_ips:
            print(f"   * http://{ip}:{port}")
    print("==================================================================")
    
    try:
        uvicorn.run("backend.main:app", host=host, port=port, reload=False, workers=1)
    except OSError as e:
        if "10048" in str(e) or "address already in use" in str(e).lower():
            print(f"\n[ERROR] Port {port} is currently in use by another process.")
            print(f"To fix, run in PowerShell: Stop-Process -Id (Get-NetTCPConnection -LocalPort {port}).OwningProcess -Force")
        else:
            raise e
