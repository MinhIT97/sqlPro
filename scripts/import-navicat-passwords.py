#!/usr/bin/env python3
import io
import os
import sys
import json
import struct
import winreg
from cryptography.hazmat.primitives.hashes import Hash, SHA1
from cryptography.hazmat.primitives.ciphers import Cipher
from cryptography.hazmat.primitives.ciphers.algorithms import AES
from cryptography.hazmat.decrepit.ciphers.algorithms import Blowfish
from cryptography.hazmat.primitives.ciphers.modes import ECB, CBC, GCM
from cryptography.hazmat.primitives.padding import PKCS7

def align_down(x: int, alignment: int) -> int:
    return (x // alignment) * alignment

def align_up(x: int, alignment: int) -> int:
    return align_down(x + (alignment - 1), alignment)

def xor_bytes(a: bytes, b: bytes) -> bytes:
    return bytes(i ^ j for i, j in zip(a, b))

def fetch_navicat_cred() -> bytes:
    import win32cred
    return bytes.fromhex(win32cred.CredRead('navicat_cred', win32cred.CRED_TYPE_GENERIC)['CredentialBlob'].decode('ascii'))

def derive_v3_key_from_navicat_cred(data: bytes) -> bytes:
    TABLE = bytes(i + 1 for i in range(32))
    aes256_key = bytearray(data)
    aes256_key[25:25 + 4] = map(lambda i: TABLE[i], (2, 0, 2, 5))
    return bytes(aes256_key)

class NavicatCryptoV1:
    def __init__(self):
        sha1 = Hash(SHA1())
        sha1.update(b'3DC5CA39')
        self._key = sha1.finalize()
        self._cipher = Cipher(Blowfish(self._key), ECB())
        self._ecb_encryptor = self._cipher.encryptor()
        self._ecb_decryptor = self._cipher.decryptor()
        with io.BytesIO() as buf:
            buf.write(self._ecb_encryptor.update(b'\xff\xff\xff\xff\xff\xff\xff\xff'))
            self._initial_vector = buf.getvalue()

    def decrypt_string(self, s: str) -> str:
        blocksize = 8
        current_vector = self._initial_vector
        ciphertext = bytes.fromhex(s)
        rounds, leftover = divmod(len(ciphertext), blocksize)
        with io.BytesIO() as plaintext_buf:
            for off in range(0, rounds * blocksize, blocksize):
                t = self._ecb_decryptor.update(ciphertext[off:off + blocksize])
                t = xor_bytes(t, current_vector)
                current_vector = xor_bytes(current_vector, ciphertext[off:off + blocksize])
                plaintext_buf.write(t)
            if leftover > 0:
                current_vector = self._ecb_encryptor.update(current_vector)
                plaintext_buf.write(xor_bytes(ciphertext[rounds * blocksize:], current_vector[:leftover]))
            return plaintext_buf.getvalue().decode('ascii', errors='ignore')

class NavicatCryptoV2:
    def __init__(self):
        self._key = b'libcckeylibcckey'
        self._initial_vector = b'libcciv libcciv '

    def decrypt_string(self, s: str) -> str:
        ciphertext = bytes.fromhex(s)
        cipher = Cipher(AES(self._key), CBC(self._initial_vector))
        decryptor = cipher.decryptor()
        padding = PKCS7(AES.block_size)
        unpadder = padding.unpadder()
        with io.BytesIO() as buf:
            buf.write(decryptor.update(ciphertext))
            buf.write(decryptor.finalize())
            padded = buf.getvalue()
        with io.BytesIO() as buf:
            buf.write(unpadder.update(padded))
            buf.write(unpadder.finalize())
            return buf.getvalue().decode('ascii', errors='ignore')

class NavicatCryptoV3:
    def __init__(self, key: bytes):
        self._key = bytes(key)

    def _unpad(self, data: bytes):
        blocksize = 16
        content_length, = struct.unpack('<H', data[:2])
        total_length = align_up(2 + content_length, blocksize)
        padding_length = total_length - (2 + content_length)
        content, _ = struct.unpack('{:d}s{:d}s'.format(content_length, padding_length), data[2:])
        return content

    def decrypt_string(self, s: str) -> str:
        data = bytes.fromhex(s)
        nonce, ciphertext, tag = struct.unpack('12s{:d}s16s'.format(len(data) - 12 - 16), data)
        cipher = Cipher(AES(self._key), GCM(nonce, tag))
        decryptor = cipher.decryptor()
        with io.BytesIO() as buf:
            buf.write(decryptor.update(ciphertext))
            buf.write(decryptor.finalize())
            return self._unpad(buf.getvalue()).decode('ascii', errors='ignore')

def get_crypto():
    v1 = NavicatCryptoV1()
    v2 = NavicatCryptoV2()
    v3 = None
    try:
        cred = fetch_navicat_cred()
        v3 = NavicatCryptoV3(derive_v3_key_from_navicat_cred(cred))
    except Exception as e:
        pass

    def decrypt(val, version=None):
        if not val or not isinstance(val, str):
            return ''
        val = val.strip()
        if not val:
            return ''
        if version == 3 and v3:
            try:
                return v3.decrypt_string(val)
            except Exception:
                pass
        if version == 2:
            try:
                return v2.decrypt_string(val)
            except Exception:
                pass
        # Try v3 first if hex length is >= 56
        if v3 and len(val) >= 56:
            try:
                return v3.decrypt_string(val)
            except Exception:
                pass
        # Try v2
        try:
            return v2.decrypt_string(val)
        except Exception:
            pass
        # Try v1
        try:
            return v1.decrypt_string(val)
        except Exception:
            pass
        return ''

    return decrypt

def scan_navicat_servers():
    decrypt = get_crypto()
    results = []
    base_key = r"Software\PremiumSoft\Navicat\Servers"
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, base_key) as root_key:
            num_subkeys = winreg.QueryInfoKey(root_key)[0]
            for i in range(num_subkeys):
                subkey_name = winreg.EnumKey(root_key, i)
                try:
                    with winreg.OpenKey(root_key, subkey_name) as subkey:
                        data = {'name': subkey_name}
                        num_values = winreg.QueryInfoKey(subkey)[1]
                        for j in range(num_values):
                            val_name, val_data, _ = winreg.EnumValue(subkey, j)
                            data[val_name] = val_data
                        
                        pwd_2 = data.get('Pwd_2')
                        pwd = data.get('Pwd')
                        ssh_pwd_2 = data.get('SSH_Password_2')
                        ssh_pwd = data.get('SSH_Password')

                        db_pass = ''
                        if pwd_2:
                            db_pass = decrypt(pwd_2, version=3)
                        elif pwd:
                            db_pass = decrypt(pwd, version=1)

                        ssh_pass = ''
                        if ssh_pwd_2:
                            ssh_pass = decrypt(ssh_pwd_2, version=3)
                        elif ssh_pwd:
                            ssh_pass = decrypt(ssh_pwd, version=1)

                        results.append({
                            'name': subkey_name,
                            'host': data.get('Host', '127.0.0.1'),
                            'port': int(data.get('Port', 3306)),
                            'user': data.get('UserName', 'root'),
                            'password': db_pass,
                            'ssh_enabled': bool(int(data.get('UseSSH', 0))),
                            'ssh_host': data.get('SSH_Host', ''),
                            'ssh_port': int(data.get('SSH_Port', 22)) if data.get('SSH_Port') else 22,
                            'ssh_user': data.get('SSH_UserName', ''),
                            'ssh_password': ssh_pass
                        })
                except Exception as e:
                    pass
    except Exception as e:
        print(f"Error accessing registry: {e}", file=sys.stderr)
    return results

if __name__ == '__main__':
    servers = scan_navicat_servers()
    print(json.dumps(servers, indent=2))
