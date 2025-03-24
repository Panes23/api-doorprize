import express , {Router} from "express";
import serverless from "serverless-http";
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

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

const api = express();

// Meningkatkan batas JSON payload
api.use(express.json({ limit: '10mb' }));

// Tambahkan CORS middleware
api.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
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

const router = Router();

router.get("/", (req, res) => {
    // Mengirimkan file index.html
    res.sendFile(__dirname + "/index.html");
});

// Endpoint untuk mengambil data voucher berdasarkan username dan xcode
router.get("/source", async (req, res) => {
    try {
        // Mengambil parameter dari query
        const { username, xcode } = req.query;
        
        // Validasi input
        if (!username || !xcode) {
            return res.status(400).json({ error: "Parameter username dan xcode harus disertakan" });
        }
        
        // Standarisasi username dan website_id
        const normalizedUsername = username.trim().toLowerCase();
        const normalizedWebsiteId = xcode.trim();
        
        // Mengambil data dari database
        const { data: voucherData, error: voucherError } = await supabase
            .from('lgx_voucher')
            .select('*')
            .filter('username', 'ilike', normalizedUsername)
            .filter('websites_id', 'eq', normalizedWebsiteId);
            
        if (voucherError) {
            console.error('[ERROR] Error fetching voucher data:', voucherError);
            throw voucherError;
        }
        
        // Mendapatkan data websites yang terkait
        const websitesIds = [...new Set(voucherData.map(v => v.websites_id))];
        const { data: websitesData, error: websitesError } = await supabase
            .from('lgx_websites')
            .select('id, name')
            .in('id', websitesIds);
            
        if (websitesError) {
            console.error('[ERROR] Error fetching websites data:', websitesError);
        }
        
        // Mendapatkan data undian yang terkait
        const undianIds = [...new Set(voucherData.filter(v => v.undian_id).map(v => v.undian_id))];
        const { data: undianData, error: undianError } = await supabase
            .from('lgx_undian')
            .select('id, periode_lomba')
            .in('id', undianIds);
            
        if (undianError) {
            console.error('[ERROR] Error fetching undian data:', undianError);
        }
        
        // Membuat lookup untuk data websites dan undian
        const websitesLookup = (websitesData || []).reduce((acc, web) => {
            acc[web.id] = web.name;
            return acc;
        }, {});
        
        const undianLookup = (undianData || []).reduce((acc, undian) => {
            acc[undian.id] = undian.periode_lomba;
            return acc;
        }, {});
        
        // Memformat data respons
        const formattedData = voucherData.map(voucher => ({
            lgx_voucher: voucher.lgx_voucher,
            username: voucher.username,
            created_at: voucher.created_at,
            websites: websitesLookup[voucher.websites_id] || voucher.websites_id,
            status: voucher.status,
            nominal: voucher.nominal,
            kode_undian: voucher.undian_id ? undianLookup[voucher.undian_id] || null : null,
            hasil_undi: voucher.hasil_undi
        }));
        
        // Mengembalikan hasil
        res.status(200).json({
            success: true,
            count: formattedData.length,
            data: formattedData
        });
    } catch (error) {
        console.error('[ERROR] Error in fetching voucher data:', error);
        res.status(500).json({ 
            success: false,
            error: error.message 
        });
    }
});

// Endpoint untuk mendapatkan URL live terbaru
router.get("/live-url", async (req, res) => {
    try {
        // Mengambil data dari tabel lgx_pasaran_live menggunakan supabaseAdmin (bypass RLS)
        const { data, error } = await supabaseAdmin
            .from('lgx_pasaran_live')
            .select('live_url, time_live, name')
            .order('created_at', { ascending: false })
            .limit(1);
            
        if (error) {
            console.error('[ERROR] Error fetching live URL:', error);
            return res.status(500).json({ 
                success: false,
                error: 'Terjadi kesalahan saat mengambil URL live'
            });
        }
        
        // Jika tidak ada data, berikan respons default
        if (!data || data.length === 0) {
            return res.status(200).json({
                success: true,
                live_url: null,
                time_live: null,
                name: null,
                message: 'Tidak ada data URL live tersedia'
            });
        }
        
        // Mengembalikan data live pertama
        res.status(200).json({
            success: true,
            live_url: data[0].live_url,
            time_live: data[0].time_live,
            name: data[0].name
        });
    } catch (error) {
        console.error('[ERROR] Error in fetching live URL:', error);
        res.status(500).json({ 
            success: false,
            error: error.message || 'Terjadi kesalahan yang tidak diketahui'
        });
    }
});

// Endpoint untuk menambahkan voucher baru
router.post("/vouchers", authenticateApiRequest, async (req, res) => {
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
            return res.status(401).json({ 
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
            return res.status(401).json({ 
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
            return res.status(402).json({ 
                error: `Maaf, total pemasangan anda sebesar Rp.${nominal} belum cukup untuk mendapatkan voucher Doorprize Lotto Genting. Silahkan Lakukan 1 invoice pemasangan setelah diskon lebih dari Rp.${configData.minimal_nominal} Untuk mendapatkan voucher Doorprize Lotto Genting.` 
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

        // Mengambil data pasaran live dari tabel lgx_pasaran_live
        let pasaranLiveData = [];
        let pasaranLiveError = null;
        
        try {
            const response = await supabaseAdmin
                .from('lgx_pasaran_live')
                .select('name, time_live, live_url');
            
            pasaranLiveData = response.data || [];
            pasaranLiveError = response.error;
        } catch (e) {
            console.error('[ERROR] Error checking pasaran live table:', e);
            // Jika tabel belum ada, kita gunakan data default
        }

        // Menyiapkan daftar live event yang tersedia
        let liveEvents = '';
        let liveButtons = '';

        if (pasaranLiveData && pasaranLiveData.length > 0) {
            // Membuat daftar jadwal live event
            liveEvents = pasaranLiveData.map(live => 
                `${live.name} (${live.time_live} WIB)`
            ).join(', ');

            // Membuat daftar tombol untuk menonton live
            liveButtons = pasaranLiveData.map(live => 
                `<a href="${live.live_url}" target="_blank" style="display:inline-block;background-color:#3b82f6;color:white;padding:8px 16px;margin:5px;text-decoration:none;border-radius:4px;">Tonton Live ${live.name}</a>`
            ).join('');
        } else {
            liveEvents = "Lotto Genting 22";
            liveButtons = "";
        }

        // Tambahkan pesan sukses ke respons dengan informasi live event
        res.status(201).json({
            ...data[0],
            message: `Selamat! Anda Mendapatkan 1 Voucher Undian DOORPRIZE dengan nomor : ${data[0].lgx_voucher} yang akan di undi pada live ${liveEvents}.`,
            live_events: pasaranLiveData || [],
            live_buttons_html: liveButtons
        });
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

api.use("/api/", router);

// Tambahkan catch-all error handler (HARUS ditempatkan setelah semua rute dan router)
api.use((err, req, res, next) => {
    // Log error ke console
    console.error('[ERROR] Uncaught exception:', err.message || err);
    
    // Log stack trace jika tersedia
    if (err.stack) {
        console.error('[ERROR] Stack trace:', err.stack);
    }
    
    // Sediakan response yang tidak terlalu detail untuk client
    res.status(500).json({ 
        error: 'Terjadi kesalahan pada server',
        message: err.message || 'Unknown error',
        timestamp: new Date().toISOString()
    });
});

// Logging jalur API yang terdaftar 
console.log('[INFO] Jalur API terdaftar:');
console.log('- GET /api/ - Halaman utama/info API');
// Hapus log untuk endpoint GET /api/vouchers
// console.log('- GET /api/vouchers - Dapatkan semua voucher');
console.log('- POST /api/vouchers [perlu autentikasi] - Buat voucher baru');
console.log('- GET /api/source - Dapatkan data voucher berdasarkan username dan xcode');
console.log('- GET /api/live-url - Dapatkan URL live terbaru');

// Konfigurasi serverless
const serverlessConfig = {
    handler: api
};

export const handler = serverless(api, serverlessConfig);