package dev.lisaexists.customvoicemessages

import java.io.Closeable
import java.io.File
import java.nio.charset.StandardCharsets
import java.security.SecureRandom

/** Minimal Ogg page writer for standard mono Opus streams (mapping family 0). */
internal class OggOpusWriter(file: File) : java.io.Closeable {
    private val output = file.outputStream().buffered(64 * 1024)
    private val serial = SecureRandom().nextInt()
    private var pageSequence = 0

    fun writeHeaders(preSkip: Int) {
        val head = ByteArray(19)
        val signature = "OpusHead".toByteArray(StandardCharsets.US_ASCII)
        System.arraycopy(signature, 0, head, 0, signature.size)
        head[8] = 1 // OpusHead version
        head[9] = 1 // mono
        putShortLe(head, 10, preSkip)
        putIntLe(head, 12, 48_000) // original input sample rate, informational
        putShortLe(head, 16, 0) // output gain in Q7.8 dB
        head[18] = 0 // mapping family 0 (one or two channels)
        writePage(head, granulePosition = 0L, flags = 0x02) // BOS

        val vendor = "Custom Voice Messages / Concentus 1.0.2".toByteArray(StandardCharsets.UTF_8)
        val tags = ByteArray(8 + 4 + vendor.size + 4)
        System.arraycopy("OpusTags".toByteArray(StandardCharsets.US_ASCII), 0, tags, 0, 8)
        putIntLe(tags, 8, vendor.size)
        System.arraycopy(vendor, 0, tags, 12, vendor.size)
        putIntLe(tags, 12 + vendor.size, 0) // zero user comments
        writePage(tags, granulePosition = 0L, flags = 0)
    }

    fun writeAudioPacket(packet: ByteArray, granulePosition: Long, isLast: Boolean) {
        require(packet.isNotEmpty()) { "An Ogg Opus audio packet cannot be empty." }
        require(packet.size <= 65_025) { "Ogg Opus packet is too large to fit in a page." }
        writePage(packet, granulePosition, if (isLast) 0x04 else 0) // EOS on final packet
    }

    private fun writePage(packet: ByteArray, granulePosition: Long, flags: Int) {
        val lacing = ArrayList<Int>()
        var remaining = packet.size
        while (remaining >= 255) {
            lacing.add(255)
            remaining -= 255
        }
        // The terminating lacing value is required even when packet.size is a multiple of 255.
        lacing.add(remaining)
        require(lacing.size <= 255) { "Ogg page requires too many lacing values." }

        val headerSize = 27 + lacing.size
        val page = ByteArray(headerSize + packet.size)
        page[0] = 'O'.code.toByte()
        page[1] = 'g'.code.toByte()
        page[2] = 'g'.code.toByte()
        page[3] = 'S'.code.toByte()
        page[4] = 0 // Ogg bitstream version
        page[5] = flags.toByte()
        putLongLe(page, 6, granulePosition)
        putIntLe(page, 14, serial)
        putIntLe(page, 18, pageSequence)
        putIntLe(page, 22, 0) // checksum field must be zero during CRC calculation
        page[26] = lacing.size.toByte()
        lacing.forEachIndexed { index, value -> page[27 + index] = value.toByte() }
        System.arraycopy(packet, 0, page, headerSize, packet.size)
        putIntLe(page, 22, oggCrc(page))
        output.write(page)
        pageSequence += 1
    }

    override fun close() {
        output.flush()
        output.close()
    }

    private fun oggCrc(bytes: ByteArray): Int {
        var crc = 0
        for (byte in bytes) {
            crc = crc xor ((byte.toInt() and 0xff) shl 24)
            repeat(8) {
                crc = if (crc < 0) (crc shl 1) xor 0x04c11db7 else crc shl 1
            }
        }
        return crc
    }

    private fun putShortLe(buffer: ByteArray, offset: Int, value: Int) {
        buffer[offset] = (value and 0xff).toByte()
        buffer[offset + 1] = ((value ushr 8) and 0xff).toByte()
    }

    private fun putIntLe(buffer: ByteArray, offset: Int, value: Int) {
        buffer[offset] = (value and 0xff).toByte()
        buffer[offset + 1] = ((value ushr 8) and 0xff).toByte()
        buffer[offset + 2] = ((value ushr 16) and 0xff).toByte()
        buffer[offset + 3] = ((value ushr 24) and 0xff).toByte()
    }

    private fun putLongLe(buffer: ByteArray, offset: Int, value: Long) {
        for (i in 0 until 8) buffer[offset + i] = ((value ushr (8 * i)) and 0xffL).toByte()
    }
}
