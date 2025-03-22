const express = require("express");
const dotenv = require("dotenv");
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

dotenv.config();

const supabaseUrl = process.env.PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.PUBLIC_SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_SECRET_KEY = process.env.API_SECRET_KEY || 'doorprize-default-secret-key'; // Kunci rahasia API

// Konfigurasi Supabase untuk banyak koneksi bersamaan
const supabaseOptions = {
    auth: {
        persistSession: false, // Tidak perlu session persistence untuk API server
        autoRefreshToken: false, // Tidak perlu auto refresh untuk service roles
        detectSessionInUrl: false // Tidak perlu deteksi URL
    },
    global: {
        // Meningkatkan batas koneksi untuk menangani banyak permintaan bersamaan
        fetch: (...args) => fetch(...args)
    }
};

// Client untuk operasi select
const supabase = createClient(supabaseUrl, supabaseKey, supabaseOptions);
// Client dengan service role key untuk operasi insert (bypasses RLS)
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, supabaseOptions);

const app = express();
const PORT = process.env.PORT || 3000;

// Meningkatkan batas JSON payload
app.use(express.json({ limit: '10mb' }));

// Middleware untuk meningkatkan timeout request
app.use((req, res, next) => {
    req.setTimeout(120000); // 2 menit timeout per request
    res.setTimeout(120000);
    next();
});

// Middleware untuk autentikasi API
const authenticateApiRequest = (req, res, next) => {
    // Ambil token hanya dari header x-api-key
    const token = req.headers['x-api-key'];
    
    console.log('[AUTH] Memeriksa autentikasi untuk request:', { 
        path: req.path,
        method: req.method,
        hasToken: !!token,
        remoteIP: req.ip || req.connection.remoteAddress
    });

    // Cek apakah token valid
    if (!token || token !== API_SECRET_KEY) {
        return res.status(401).json({ 
            error: 'Access denied. You do not have permission to perform this operation.'
        });
    }

    console.log('[AUTH] Autentikasi berhasil');
    // Jika token valid, lanjutkan ke handler berikutnya
    next();
};

app.get("/", (req, res) => {
    res.send("API Doorprize berjalan dengan baik!");
});

app.get("/api/vouchers", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('lgx_voucher')
            .select('*');
        
        if (error) throw error;
        
        res.status(200).json(data);
    } catch (error) {
        console.error('[ERROR] Error fetching vouchers:', error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint untuk menambahkan voucher baru
app.post("/api/vouchers", authenticateApiRequest, async (req, res) => {
    try {
        // Ambil data dari body request
        const { username, websites_id, nominal } = req.body;

        // Validasi input
        if (!username || !websites_id || !nominal) {
            return res.status(400).json({ error: "Username, websites_id, dan nominal harus diisi!" });
        }

        // Standarisasi username dan websites_id untuk memastikan konsistensi
        const normalizedUsername = username.trim().toLowerCase();
        const normalizedWebsitesId = websites_id.trim();

        // LANGKAH 1: Periksa semua voucher yang aktif (lebih umum)
        const { data: allActiveVouchers, error: activeVouchersError } = await supabaseAdmin
            .from('lgx_voucher')
            .select('*')
            .eq('status', 'active');

        if (activeVouchersError) {
            console.error('[ERROR] Error fetching active vouchers:', activeVouchersError);
            throw activeVouchersError;
        }

        // LANGKAH 2: Filter secara manual untuk username dan websites_id
        const matchingVouchers = allActiveVouchers.filter(v => 
            v.username.trim().toLowerCase() === normalizedUsername && 
            v.websites_id.trim() === normalizedWebsitesId
        );

        // Jika sudah ada voucher aktif, kembalikan pesan error
        if (matchingVouchers.length > 0) {
            return res.status(400).json({ 
                error: `Anda masih memilki undian Aktif kode ${matchingVouchers[0].lgx_voucher}` 
            });
        }

        
        const { data: existingVouchers, error: existingVoucherError } = await supabaseAdmin
            .from('lgx_voucher')
            .select('*')
            .filter('username', 'ilike', normalizedUsername)
            .filter('websites_id', 'eq', normalizedWebsitesId)
            .filter('status', 'eq', 'active');

        if (existingVoucherError) {
            console.error('[ERROR] Error on double-check query:', existingVoucherError);
            throw existingVoucherError;
        }

        if (existingVouchers && existingVouchers.length > 0) {
            return res.status(400).json({ 
                error: `Anda masih memilki undian Aktif kode ${existingVouchers[0].lgx_voucher}` 
            });
        }

        // Ambil config untuk validasi nominal dan expired_date
        const { data: configData, error: configError } = await supabaseAdmin
            .from('lgx_config')
            .select('minimal_nominal, max_day_exp_voucher')
            .single();

        if (configError) {
            console.error('[ERROR] Error fetching config:', configError);
            throw configError;
        }

        // Validasi nominal
        if (nominal < configData.minimal_nominal) {
            return res.status(400).json({ 
                error: `Nominal tidak boleh kurang dari Rp.${configData.minimal_nominal} Untuk mendapatkan voucher Doorprize.` 
            });
        }

        // Hitung tanggal expired
        const createdAt = new Date();
        const expiredDate = new Date(createdAt);
        expiredDate.setDate(expiredDate.getDate() + configData.max_day_exp_voucher);
        const formattedExpiredDate = expiredDate.toISOString().split('T')[0];

        // Generate ID baru
        const id = uuidv4();

        // Generate kode voucher yang unik
        const voucherCode = await generateUniqueVoucherCode();
        if (!voucherCode) {
            return res.status(500).json({ error: "Tidak dapat menghasilkan kode voucher unik" });
        }

        // Buat objek data voucher baru - gunakan nilai yang dinormalisasi
        const voucherData = {
            lgx_voucher: voucherCode,
            username: normalizedUsername, // Menggunakan username yang dinormalisasi
            created_at: createdAt.toISOString(),
            updated_at: createdAt.toISOString(),
            id,
            expired_date: formattedExpiredDate,
            websites_id: normalizedWebsitesId, // Menggunakan websites_id yang dinormalisasi
            status: 'active',
            player_status: 'real',
            nominal,
            undian_id: null,
            hasil_undi: null
        };

        // Insert data ke tabel lgx_voucher menggunakan supabaseAdmin untuk melewati RLS
        const { data, error } = await supabaseAdmin
            .from('lgx_voucher')
            .insert([voucherData])
            .select();

        if (error) {
            console.error('[ERROR] Error inserting voucher:', error);
            throw error;
        }

        res.status(201).json(data[0]);
    } catch (error) {
        console.error('[ERROR] Error in voucher creation:', error);
        res.status(500).json({ error: error.message });
    }
});

// Fungsi untuk menghasilkan kode voucher unik
async function generateUniqueVoucherCode() {
    try {
        // Menggunakan transaction SQL di Supabase untuk mendapatkan ID unik dari sequence
        const { data, error } = await supabaseAdmin.rpc('generate_voucher_code');

        if (error) {
            console.error('[ERROR] Error generating voucher code:', error);
            throw error;
        }

        if (!data) {
            throw new Error('Tidak dapat menghasilkan kode voucher');
        }

        return data;
    } catch (error) {
        console.error('[ERROR] Exception in generateUniqueVoucherCode:', error);
        
        // Fallback ke metode lama jika RPC tidak tersedia
        return generateVoucherCodeFallback();
    }
}

// Metode fallback jika RPC tidak tersedia
async function generateVoucherCodeFallback() {
    let isUnique = false;
    let voucherCode = "";
    let prefix = "LG1";
    let maxAttempts = 10; // Batasan untuk menghindari loop tak terbatas
    let attempts = 0;

    while (!isUnique && attempts < maxAttempts) {
        try {
            // Cari prefix tertinggi saat ini dengan SQL langsung untuk lebih efisien
            const { data: prefixData, error: prefixError } = await supabaseAdmin.rpc('get_current_prefix');
            
            if (!prefixError && prefixData) {
                prefix = prefixData;
            } else {
                // Cari prefix tertinggi saat ini dari tabel
                const { data: maxPrefixData, error: maxPrefixError } = await supabaseAdmin
                    .from('lgx_voucher')
                    .select('lgx_voucher')
                    .order('lgx_voucher', { ascending: false })
                    .limit(1);

                if (!maxPrefixError && maxPrefixData && maxPrefixData.length > 0) {
                    const currentMaxPrefix = maxPrefixData[0].lgx_voucher.substring(0, 3);
                    if (currentMaxPrefix.startsWith('LG')) {
                        const prefixNumber = parseInt(currentMaxPrefix.substring(2), 10);
                        if (!isNaN(prefixNumber)) {
                            prefix = `LG${prefixNumber}`;
                        }
                    }
                }
            }

            // Generate kode acak dengan lebih banyak entropy
            const timestamp = Date.now().toString().slice(-6);
            const random = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
            voucherCode = `${prefix}-${timestamp}${random.substring(0, 6 - timestamp.length)}`;

            // Cek apakah kode sudah ada di database
            const { data, error } = await supabaseAdmin
                .from('lgx_voucher')
                .select('lgx_voucher')
                .eq('lgx_voucher', voucherCode)
                .maybeSingle();

            if (error) throw error;

            // Jika tidak ada data, berarti kode unik
            if (!data) {
                isUnique = true;
            }
        } catch (err) {
            console.error('[ERROR] Error in generateVoucherCodeFallback:', err);
        }

        attempts++;
    }

    if (!isUnique) {
        throw new Error('Tidak dapat menghasilkan kode voucher unik setelah beberapa percobaan');
    }

    return voucherCode;
}

// Meningkatkan batas koneksi HTTP
require('http').globalAgent.maxSockets = 1000;
// Meningkatkan batas listener event
require('events').EventEmitter.defaultMaxListeners = 100;

// Penanganan kesalahan tak terduga
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
}); 

// Memulai server dengan penanganan error
const server = app.listen(PORT, () => {
    console.log(`Server berjalan di port ${PORT}`);
    
    // Log API startup
    console.log('===================================================');
    console.log(`[INFO] API Doorprize dimulai dengan konfigurasi:`);
    console.log(`[INFO] - Autentikasi API: ${API_SECRET_KEY ? 'AKTIF' : 'NONAKTIF'}`);
    console.log(`[INFO] - Service Role Key: ${supabaseServiceKey ? (supabaseServiceKey.substring(0, 10) + '...') : 'TIDAK TERSEDIA'}`);
    console.log(`[INFO] - Max Socket: 1000`);
    console.log(`[INFO] - Timeout: 120 detik`);
    console.log('===================================================');
    console.log('[INFO] Jalur API terdaftar:');
    console.log('- GET / - Halaman utama');
    console.log('- GET /api/vouchers - Dapatkan semua voucher');
    console.log('- POST /api/vouchers [perlu autentikasi] - Buat voucher baru');
});

server.on('error', (error) => {
    console.error('[ERROR] Server error:', error);
    if (error.code === 'EADDRINUSE') {
        console.error(`[ERROR] Port ${PORT} sudah digunakan. Pastikan tidak ada server lain yang berjalan di port tersebut.`);
    }
}); 