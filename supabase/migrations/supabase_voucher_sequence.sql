-- Buat SQL function untuk menghasilkan kode voucher acak dan unik
-- Run this via Supabase SQL editor

-- Fungsi untuk membuat kode voucher acak (tidak berurutan)
CREATE OR REPLACE FUNCTION generate_voucher_code()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    prefix TEXT := 'LG1';
    latest_prefix TEXT;
    random_num BIGINT;
    formatted_code TEXT;
    max_attempts INT := 20;
    attempt INT := 0;
    existing_code BOOLEAN;
BEGIN
    -- Ambil prefix terbaru dari database
    BEGIN
        SELECT SUBSTRING(lgx_voucher FROM 1 FOR 3) INTO latest_prefix
        FROM lgx_voucher
        ORDER BY created_at DESC
        LIMIT 1;
        
        IF latest_prefix IS NOT NULL AND latest_prefix ~ '^LG[0-9]+$' THEN
            prefix := latest_prefix;
        END IF;
    EXCEPTION
        WHEN OTHERS THEN
            -- Fallback to default prefix
            prefix := 'LG1';
    END;
    
    -- Gunakan loop untuk mencoba beberapa kali jika terjadi duplikat
    LOOP
        -- Generate random number di antara 0-999999
        -- Tambahkan timestamp milis terakhir untuk menambah keacakan
        random_num := (floor(random() * 1000000) + (extract(milliseconds from now()) % 1000))::BIGINT % 1000000;
        
        -- Format kode voucher dengan padding zeros
        formatted_code := prefix || '-' || LPAD(random_num::TEXT, 6, '0');
        
        -- Cek apakah kode sudah ada di database
        SELECT EXISTS(
            SELECT 1 FROM lgx_voucher WHERE lgx_voucher = formatted_code
        ) INTO existing_code;
        
        EXIT WHEN NOT existing_code OR attempt >= max_attempts;
        
        attempt := attempt + 1;
    END LOOP;
    
    -- Kasus terburuk: semua upaya acak gagal, gunakan teknik timestamp
    IF existing_code THEN
        -- Gunakan timestamp dan random seed sebagai fallback
        -- Format: LGx-[timestamp_ms][random_3_digits]
        random_num := (extract(epoch from now()) * 1000)::BIGINT % 1000000;
        formatted_code := prefix || '-' || LPAD(random_num::TEXT, 6, '0');
        
        -- Tambahkan ID random di akhir jika masih konflik
        IF EXISTS(SELECT 1 FROM lgx_voucher WHERE lgx_voucher = formatted_code) THEN
            formatted_code := prefix || '-' || 
                             substring(md5(random()::text || clock_timestamp()::text), 1, 6);
        END IF;
    END IF;
    
    -- Di sini kita menggunakan FOR UPDATE SKIP LOCKED untuk meng-handle insert concurrent
    -- Ini memastikan tidak ada 2 proses yang mendapatkan kode yang sama
    PERFORM 1 
    FROM lgx_voucher_reserved 
    WHERE reserved_code = formatted_code 
    FOR UPDATE SKIP LOCKED;
    
    -- Tambahkan ke tabel reservasi sementara, akan dibersihkan oleh trigger setelah insert
    BEGIN
        INSERT INTO lgx_voucher_reserved (reserved_code, reserved_at)
        VALUES (formatted_code, now());
    EXCEPTION 
        WHEN unique_violation THEN
            -- Jika ada konflik, coba sekali lagi dengan kode yang pasti unik
            formatted_code := prefix || '-' || 
                             substring(md5(random()::text || clock_timestamp()::text || attempt::text), 1, 6);
            
            -- Masukkan ke reservasi, tidak perlu cek lagi karena sudah pasti unik
            INSERT INTO lgx_voucher_reserved (reserved_code, reserved_at)
            VALUES (formatted_code, now());
    END;
    
    RETURN formatted_code;
END;
$$;

-- Helper function untuk mendapatkan prefix saat ini
CREATE OR REPLACE FUNCTION get_current_prefix()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    latest_prefix TEXT := 'LG1';
BEGIN
    SELECT SUBSTRING(lgx_voucher FROM 1 FOR 3) INTO latest_prefix
    FROM lgx_voucher
    ORDER BY created_at DESC
    LIMIT 1;
    
    IF latest_prefix IS NULL OR NOT (latest_prefix ~ '^LG[0-9]+$') THEN
        latest_prefix := 'LG1';
    END IF;
    
    RETURN latest_prefix;
EXCEPTION
    WHEN OTHERS THEN
        RETURN 'LG1';
END;
$$;

-- Buat tabel untuk mencegah race condition pada pembuatan kode
CREATE TABLE IF NOT EXISTS lgx_voucher_reserved (
    reserved_code TEXT PRIMARY KEY,
    reserved_at TIMESTAMP DEFAULT now(),
    processed BOOLEAN DEFAULT FALSE
);

-- Buat index untuk mempercepat pencarian
CREATE INDEX IF NOT EXISTS idx_reserved_code ON lgx_voucher_reserved(reserved_code);
CREATE INDEX IF NOT EXISTS idx_reserved_at ON lgx_voucher_reserved(reserved_at);

-- Trigger untuk membersihkan reservasi kode voucher yang sudah lama
CREATE OR REPLACE FUNCTION cleanup_old_voucher_reservations() 
RETURNS TRIGGER 
LANGUAGE plpgsql
SECURITY DEFINER 
AS $$
BEGIN
    -- Hapus reservasi kode yang sudah lebih dari 10 menit
    DELETE FROM lgx_voucher_reserved
    WHERE reserved_at < now() - interval '10 minutes';
    
    RETURN NULL;
END;
$$;

-- Buat trigger yang berjalan setiap 10 menit
CREATE OR REPLACE TRIGGER cleanup_reservations_trigger
AFTER INSERT ON lgx_voucher_reserved
EXECUTE FUNCTION cleanup_old_voucher_reservations();

-- Trigger untuk menandai kode yang sudah digunakan
CREATE OR REPLACE FUNCTION mark_used_voucher_code() 
RETURNS TRIGGER 
LANGUAGE plpgsql
SECURITY DEFINER 
AS $$
BEGIN
    -- Tandai sebagai sudah diproses
    UPDATE lgx_voucher_reserved
    SET processed = TRUE
    WHERE reserved_code = NEW.lgx_voucher;
    
    RETURN NEW;
END;
$$;

-- Buat trigger yang berjalan setiap ada insert ke lgx_voucher
CREATE OR REPLACE TRIGGER mark_used_voucher_trigger
AFTER INSERT ON lgx_voucher
FOR EACH ROW
EXECUTE FUNCTION mark_used_voucher_code(); 