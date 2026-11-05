require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const path = require("path");
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET;

app.set("trust proxy", 1);

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "";

const SUPABASE_URL =
  process.env.SUPABASE_URL;

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_BUCKET =
  "website-images";

if (!JWT_SECRET) {
  console.error("JWT_SECRET missing in .env");
  process.exit(1);
}

if (!SUPABASE_URL) {
  console.error("SUPABASE_URL missing in .env");
  process.exit(1);
}

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "SUPABASE_SERVICE_ROLE_KEY missing in .env"
  );
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

function buildPublicUrl(req, relativePath) {
  if (!relativePath) return null;

  if (
    relativePath.startsWith("http://") ||
    relativePath.startsWith("https://")
  ) {
    return relativePath;
  }

  if (PUBLIC_BASE_URL) {
    return `${PUBLIC_BASE_URL.replace(
      /\/$/,
      ""
    )}${relativePath}`;
  }

  return `${req.protocol}://${req.get(
    "host"
  )}${relativePath}`;
}

function getStoragePathFromPublicUrl(url) {
  if (!url) return null;

  const marker =
    `/storage/v1/object/public/${SUPABASE_BUCKET}/`;

  const index = url.indexOf(marker);

  if (index === -1) {
    return null;
  }

  return decodeURIComponent(
    url.substring(index + marker.length)
  );
}

async function uploadFileToSupabase(
  localPath,
  storagePath,
  contentType
) {
  const fileBuffer =
    fs.readFileSync(localPath);

  const { error } =
    await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(
        storagePath,
        fileBuffer,
        {
          contentType,
          upsert: true,
        }
      );

  if (error) {
    throw error;
  }

  const { data } =
    supabase.storage
      .from(SUPABASE_BUCKET)
      .getPublicUrl(storagePath);

  if (!data || !data.publicUrl) {
    throw new Error(
      "Failed to generate Supabase public URL."
    );
  }

  return data.publicUrl;
}

async function deleteFromSupabase(publicUrl) {
  const storagePath =
    getStoragePathFromPublicUrl(
      publicUrl
    );

  if (!storagePath) {
    return;
  }

  const { error } =
    await supabase.storage
      .from(SUPABASE_BUCKET)
      .remove([storagePath]);

  if (error) {
    console.error(
      "Supabase delete error:",
      error.message
    );
  }
}

async function initializeDatabase() {
  const client = await pool.connect();

  try {
    console.log(
      "PostgreSQL connected successfully!"
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS site_images (
        id SERIAL PRIMARY KEY,
        image_type VARCHAR(50) UNIQUE NOT NULL,
        image_url TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log(
      "Site images table ready."
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS gallery (
        id SERIAL PRIMARY KEY,
        title VARCHAR(150) NOT NULL,
        category VARCHAR(100) NOT NULL,
        image_url TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log(
      "Gallery table ready."
    );
  } catch (error) {
    console.error(
      "Database initialization error:",
      error.message
    );
  } finally {
    client.release();
  }
}

initializeDatabase().catch((error) => {
  console.error(
    "Database initialization failed:",
    error.message
  );
});

/*
  Temporary local upload directory.

  Multer first receives the file here.
  The file is immediately uploaded to
  Supabase Storage and then deleted locally.

  Therefore Render's filesystem is NOT used
  for permanent image storage.
*/

const uploadsDir =
  path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, {
    recursive: true,
  });
}

app.use(
  "/uploads",
  express.static(uploadsDir)
);

const storage =
  multer.diskStorage({
    destination: function (
      req,
      file,
      cb
    ) {
      cb(null, uploadsDir);
    },

    filename: function (
      req,
      file,
      cb
    ) {
      const ext =
        path.extname(
          file.originalname
        );

      const filename =
        `temp-${Date.now()}-${Math.round(
          Math.random() * 1e9
        )}${ext}`;

      cb(null, filename);
    },
  });

const fileFilter =
  function (req, file, cb) {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
    ];

    if (
      allowedTypes.includes(
        file.mimetype
      )
    ) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Only JPG, PNG and WEBP images are allowed."
        )
      );
    }
  };

const upload =
  multer({
    storage,
    fileFilter,
    limits: {
      fileSize: 5 * 1024 * 1024,
    },
  });

function authenticateAdmin(
  req,
  res,
  next
) {
  const authHeader =
    req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      success: false,
      message:
        "Authorization token missing.",
    });
  }

  const parts =
    authHeader.split(" ");

  if (
    parts.length !== 2 ||
    parts[0] !== "Bearer"
  ) {
    return res.status(401).json({
      success: false,
      message:
        "Invalid authorization token.",
    });
  }

  const token = parts[1];

  try {
    const decoded =
      jwt.verify(
        token,
        JWT_SECRET
      );

    req.admin = decoded;

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message:
        "Invalid or expired token.",
    });
  }
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    message:
      "Shree Photo Studio backend is running.",
  });
});

app.get(
  "/api/categories",
  async (req, res) => {
    try {
      const result =
        await pool.query(`
          SELECT
            id,
            name,
            slug,
            description,
            created_at
          FROM categories
          ORDER BY id ASC
        `);

      res.json({
        success: true,
        categories:
          result.rows,
      });
    } catch (error) {
      console.error(
        "Categories error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to load categories.",
      });
    }
  }
);

app.post(
  "/api/enquiries",
  async (req, res) => {
    try {
      const {
        name,
        mobile,
        service,
        preferred_date,
        requirement,
        message,
      } = req.body;

      if (!name || !mobile) {
        return res.status(400).json({
          success: false,
          message:
            "Name and mobile are required.",
        });
      }

      const result =
        await pool.query(
          `
          INSERT INTO enquiries
          (
            name,
            mobile,
            service,
            preferred_date,
            requirement,
            message,
            status
          )
          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            'New'
          )
          RETURNING *
          `,
          [
            name,
            mobile,
            service || null,
            preferred_date || null,
            requirement || null,
            message || null,
          ]
        );

      res.status(201).json({
        success: true,
        message:
          "Enquiry submitted successfully.",
        enquiry:
          result.rows[0],
      });
    } catch (error) {
      console.error(
        "Enquiry create error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to submit enquiry.",
      });
    }
  }
);

app.post(
  "/api/admin/login",
  async (req, res) => {
    try {
      const {
        username,
        password,
      } = req.body;

      if (
        !username ||
        !password
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Username and password are required.",
        });
      }

      const result =
        await pool.query(
          `
          SELECT *
          FROM admin_users
          WHERE username = $1
          LIMIT 1
          `,
          [username]
        );

      if (
        result.rows.length === 0
      ) {
        return res.status(401).json({
          success: false,
          message:
            "Invalid username or password.",
        });
      }

      const admin =
        result.rows[0];

      const passwordMatch =
        await bcrypt.compare(
          password,
          admin.password_hash
        );

      if (!passwordMatch) {
        return res.status(401).json({
          success: false,
          message:
            "Invalid username or password.",
        });
      }

      const token =
        jwt.sign(
          {
            id: admin.id,
            username:
              admin.username,
          },
          JWT_SECRET,
          {
            expiresIn:
              "2h",
          }
        );

      res.json({
        success: true,
        message:
          "Login successful.",
        token,
        admin: {
          id: admin.id,
          username:
            admin.username,
        },
      });
    } catch (error) {
      console.error(
        "Admin login error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Login failed.",
      });
    }
  }
);

app.get(
  "/api/admin/me",
  authenticateAdmin,
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          SELECT
            id,
            username,
            created_at
          FROM admin_users
          WHERE id = $1
          LIMIT 1
          `,
          [req.admin.id]
        );

      if (
        result.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Admin not found.",
        });
      }

      res.json({
        success: true,
        admin:
          result.rows[0],
      });
    } catch (error) {
      console.error(
        "Admin me error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to load admin.",
      });
    }
  }
);

app.get(
  "/api/enquiries",
  authenticateAdmin,
  async (req, res) => {
    try {
      const result =
        await pool.query(`
          SELECT
            id,
            name,
            mobile,
            service,
            preferred_date,
            requirement,
            message,
            status,
            created_at
          FROM enquiries
          ORDER BY created_at DESC
        `);

      res.json({
        success: true,
        enquiries:
          result.rows,
      });
    } catch (error) {
      console.error(
        "Enquiries error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to load enquiries.",
      });
    }
  }
);

app.patch(
  "/api/enquiries/:id/status",
  authenticateAdmin,
  async (req, res) => {
    try {
      const enquiryId =
        req.params.id;

      const { status } =
        req.body;

      const allowedStatuses = [
        "New",
        "Contacted",
        "Completed",
      ];

      if (
        !allowedStatuses.includes(
          status
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid status.",
        });
      }

      const result =
        await pool.query(
          `
          UPDATE enquiries
          SET status = $1
          WHERE id = $2
          RETURNING *
          `,
          [
            status,
            enquiryId,
          ]
        );

      if (
        result.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Enquiry not found.",
        });
      }

      res.json({
        success: true,
        message:
          "Status updated successfully.",
        enquiry:
          result.rows[0],
      });
    } catch (error) {
      console.error(
        "Status update error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to update status.",
      });
    }
  }
);

app.delete(
  "/api/enquiries/:id",
  authenticateAdmin,
  async (req, res) => {
    try {
      const enquiryId =
        req.params.id;

      const result =
        await pool.query(
          `
          DELETE FROM enquiries
          WHERE id = $1
          RETURNING *
          `,
          [enquiryId]
        );

      if (
        result.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Enquiry not found.",
        });
      }

      res.json({
        success: true,
        message:
          "Enquiry deleted successfully.",
      });
    } catch (error) {
      console.error(
        "Delete enquiry error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to delete enquiry.",
      });
    }
  }
);

/* =========================
   LOGO
========================= */

app.post(
  "/api/admin/upload-logo",
  authenticateAdmin,
  upload.single("logo"),
  async (req, res) => {
    let localPath = null;

    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message:
            "Please select a logo image.",
        });
      }

      localPath =
        req.file.path;

      const ext =
        path.extname(
          req.file.originalname
        ).toLowerCase();

      const storagePath =
        `logo/logo-${Date.now()}${ext}`;

      const imageUrl =
        await uploadFileToSupabase(
          localPath,
          storagePath,
          req.file.mimetype
        );

      const oldResult =
        await pool.query(
          `
          SELECT image_url
          FROM site_images
          WHERE image_type = 'logo'
          LIMIT 1
          `
        );

      await pool.query(
        `
        INSERT INTO site_images
        (
          image_type,
          image_url,
          updated_at
        )
        VALUES
        (
          'logo',
          $1,
          CURRENT_TIMESTAMP
        )
        ON CONFLICT (image_type)
        DO UPDATE SET
          image_url = EXCLUDED.image_url,
          updated_at = CURRENT_TIMESTAMP
        `,
        [imageUrl]
      );

      if (
        oldResult.rows.length > 0 &&
        oldResult.rows[0].image_url
      ) {
        await deleteFromSupabase(
          oldResult.rows[0]
            .image_url
        );
      }

      if (
        localPath &&
        fs.existsSync(localPath)
      ) {
        fs.unlinkSync(
          localPath
        );
      }

      localPath = null;

      res.json({
        success: true,
        message:
          "Logo uploaded successfully.",
        image_url:
          imageUrl,
      });
    } catch (error) {
      console.error(
        "Logo upload error:",
        error.message
      );

      if (
        localPath &&
        fs.existsSync(localPath)
      ) {
        try {
          fs.unlinkSync(
            localPath
          );
        } catch {}
      }

      res.status(500).json({
        success: false,
        message:
          "Failed to upload logo.",
      });
    }
  }
);

app.get(
  "/api/admin/logo",
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          SELECT image_url
          FROM site_images
          WHERE image_type = 'logo'
          LIMIT 1
          `
        );

      if (
        result.rows.length === 0
      ) {
        return res.json({
          success: true,
          logo: null,
        });
      }

      res.json({
        success: true,
        logo:
          result.rows[0]
            .image_url,
      });
    } catch (error) {
      console.error(
        "Logo fetch error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to load logo.",
      });
    }
  }
);

/* =========================
   GALLERY
========================= */

app.get(
  "/api/gallery",
  async (req, res) => {
    try {
      const result =
        await pool.query(`
          SELECT
            id,
            title,
            category,
            image_url,
            created_at
          FROM gallery
          ORDER BY created_at DESC
        `);

      const gallery =
        result.rows.map(
          (item) => ({
            ...item,
            image_url:
              item.image_url,
          })
        );

      res.json({
        success: true,
        gallery,
      });
    } catch (error) {
      console.error(
        "Gallery fetch error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to load gallery.",
      });
    }
  }
);

app.post(
  "/api/admin/gallery",
  authenticateAdmin,
  upload.single("image"),
  async (req, res) => {
    let localPath = null;
    let uploadedUrl = null;

    try {
      const {
        title,
        category,
      } = req.body;

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message:
            "Please select an image.",
        });
      }

      if (
        !title ||
        !category
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Title and category are required.",
        });
      }

      localPath =
        req.file.path;

      const ext =
        path.extname(
          req.file.originalname
        ).toLowerCase();

      const filename =
        `gallery-${Date.now()}-${Math.round(
          Math.random() * 1e9
        )}${ext}`;

      const storagePath =
        `gallery/${filename}`;

      uploadedUrl =
        await uploadFileToSupabase(
          localPath,
          storagePath,
          req.file.mimetype
        );

      const result =
        await pool.query(
          `
          INSERT INTO gallery
          (
            title,
            category,
            image_url
          )
          VALUES
          (
            $1,
            $2,
            $3
          )
          RETURNING *
          `,
          [
            title,
            category,
            uploadedUrl,
          ]
        );

      if (
        localPath &&
        fs.existsSync(localPath)
      ) {
        fs.unlinkSync(
          localPath
        );
      }

      localPath = null;

      res.status(201).json({
        success: true,
        message:
          "Gallery image uploaded successfully.",
        gallery:
          result.rows[0],
      });
    } catch (error) {
      console.error(
        "Gallery upload error:",
        error.message
      );

      if (uploadedUrl) {
        await deleteFromSupabase(
          uploadedUrl
        );
      }

      if (
        localPath &&
        fs.existsSync(localPath)
      ) {
        try {
          fs.unlinkSync(
            localPath
          );
        } catch {}
      }

      res.status(500).json({
        success: false,
        message:
          "Failed to upload gallery image.",
      });
    }
  }
);

app.delete(
  "/api/admin/gallery/:id",
  authenticateAdmin,
  async (req, res) => {
    try {
      const galleryId =
        req.params.id;

      const result =
        await pool.query(
          `
          DELETE FROM gallery
          WHERE id = $1
          RETURNING *
          `,
          [galleryId]
        );

      if (
        result.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Gallery image not found.",
        });
      }

      const imageUrl =
        result.rows[0]
          .image_url;

      await deleteFromSupabase(
        imageUrl
      );

      res.json({
        success: true,
        message:
          "Gallery image deleted successfully.",
      });
    } catch (error) {
      console.error(
        "Gallery delete error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to delete gallery image.",
      });
    }
  }
);

/* =========================
   WEBSITE IMAGES
   hero / feature / about
========================= */

const allowedSiteImageTypes = [
  "hero",
  "feature",
  "about",
];

app.get(
  "/api/site-images",
  async (req, res) => {
    try {
      const result =
        await pool.query(`
          SELECT
            image_type,
            image_url,
            updated_at
          FROM site_images
          WHERE image_type IN
          (
            'hero',
            'feature',
            'about'
          )
          ORDER BY id ASC
        `);

      const images = {};

      result.rows.forEach(
        (row) => {
          images[
            row.image_type
          ] = row.image_url;
        }
      );

      res.json({
        success: true,
        images,
      });
    } catch (error) {
      console.error(
        "Site images fetch error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to load website images.",
      });
    }
  }
);

app.post(
  "/api/admin/site-images/:type",
  authenticateAdmin,
  upload.single("image"),
  async (req, res) => {
    let localPath = null;
    let uploadedUrl = null;

    try {
      const imageType =
        req.params.type;

      if (
        !allowedSiteImageTypes.includes(
          imageType
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid website image type.",
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message:
            "Please select an image.",
        });
      }

      localPath =
        req.file.path;

      const ext =
        path.extname(
          req.file.originalname
        ).toLowerCase();

      const filename =
        `site-${imageType}-${Date.now()}${ext}`;

      const storagePath =
        `site-images/${filename}`;

      uploadedUrl =
        await uploadFileToSupabase(
          localPath,
          storagePath,
          req.file.mimetype
        );

      const oldResult =
        await pool.query(
          `
          SELECT image_url
          FROM site_images
          WHERE image_type = $1
          LIMIT 1
          `,
          [imageType]
        );

      await pool.query(
        `
        INSERT INTO site_images
        (
          image_type,
          image_url,
          updated_at
        )
        VALUES
        (
          $1,
          $2,
          CURRENT_TIMESTAMP
        )
        ON CONFLICT (image_type)
        DO UPDATE SET
          image_url = EXCLUDED.image_url,
          updated_at = CURRENT_TIMESTAMP
        `,
        [
          imageType,
          uploadedUrl,
        ]
      );

      if (
        oldResult.rows.length > 0 &&
        oldResult.rows[0].image_url
      ) {
        await deleteFromSupabase(
          oldResult.rows[0]
            .image_url
        );
      }

      if (
        localPath &&
        fs.existsSync(localPath)
      ) {
        fs.unlinkSync(
          localPath
        );
      }

      localPath = null;

      res.json({
        success: true,
        message:
          `${imageType} image updated successfully.`,
        image_type:
          imageType,
        image_url:
          uploadedUrl,
      });
    } catch (error) {
      console.error(
        "Website image upload error:",
        error.message
      );

      if (uploadedUrl) {
        await deleteFromSupabase(
          uploadedUrl
        );
      }

      if (
        localPath &&
        fs.existsSync(localPath)
      ) {
        try {
          fs.unlinkSync(
            localPath
          );
        } catch {}
      }

      res.status(500).json({
        success: false,
        message:
          "Failed to update website image.",
      });
    }
  }
);

/* =========================
   ERROR HANDLER
========================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    if (
      error instanceof
      multer.MulterError
    ) {
      if (
        error.code ===
        "LIMIT_FILE_SIZE"
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Image size must be maximum 5 MB.",
        });
      }

      return res.status(400).json({
        success: false,
        message:
          error.message,
      });
    }

    if (error) {
      return res.status(400).json({
        success: false,
        message:
          error.message,
      });
    }

    next();
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `Server running on port ${PORT}`
    );

    if (PUBLIC_BASE_URL) {
      console.log(
        `Public URL: ${PUBLIC_BASE_URL}`
      );
    }

    console.log(
      "Supabase Storage: connected"
    );
    console.log(
      `Supabase bucket: ${SUPABASE_BUCKET}`
    );
  }
);