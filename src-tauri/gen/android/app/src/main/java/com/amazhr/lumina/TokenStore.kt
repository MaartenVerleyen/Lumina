package com.amazhr.lumina

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// Session tokens of the servers (remote.rs), encrypted with a key in Android's Keystore: the key never leaves
// the phone's secure hardware, so a copy of the app's files is no use without the phone itself
object TokenStore {
  lateinit var context: Context
  private const val KEY = "lumina-sessions"

  private fun prefs() = context.getSharedPreferences("lumina-sessions", Context.MODE_PRIVATE)

  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getEntry(KEY, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .build()
    )
    return generator.generateKey()
  }

  @JvmStatic
  fun get(name: String): String? =
    try {
      prefs().getString(name, null)?.let {
        val bytes = Base64.decode(it, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, 12))
        String(cipher.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8)
      }
    } catch (e: Exception) {
      null
    }

  @JvmStatic
  fun set(name: String, token: String): Boolean =
    try {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, key())
      val sealed = cipher.iv + cipher.doFinal(token.toByteArray(Charsets.UTF_8))
      prefs().edit().putString(name, Base64.encodeToString(sealed, Base64.NO_WRAP)).commit()
    } catch (e: Exception) {
      false
    }

  @JvmStatic
  fun delete(name: String) {
    prefs().edit().remove(name).commit()
  }
}
