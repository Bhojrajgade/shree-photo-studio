require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const path = require("path");
const fs = require("fs");

const app = express();

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error("JWT_SECRET missing in .env");
  process.exit(1);
}

/* =========================
   MIDDLEWARE
========================= */

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =========================
   DATABASE
========================= */

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

pool
  .connect()
  .then(async (client) => {
    console.log("PostgreSQL connected successfully!");

    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS site_images (
          id SERIAL PRIMARY KEY,
          image_type VARCHAR(50) UNIQUE NOT NULL,
          image_url TEXT NOT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      console.log("Site images table ready.");
    } catch (error) {
      console.error(
        "Site images table error:",
        error.message
      );
    } finally {
      client.release();
    }
  })
  .catch((error) => {
    console.error(
      "PostgreSQL connection failed:",
      error.message
    );
  });

/* =========================
   UPLOADS FOLDER
========================= */

const uploadsDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, {
    recursive: true,
  });
}

app.use(
  "/uploads",
  express.static(uploadsDir)
);

/* =========================
   MULTER
========================= */

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },

  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);

    const filename =
      `upload-${Date.now()}-${Math.round(
        Math.random() * 1e9
      )}${ext}`;

    cb(null, filename);
  },
});

const fileFilter = function (req, file, cb) {
  const allowedTypes = [
    "image/jpeg",
    "image/png",
    "image/webp",
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        "Only JPG, PNG and WEBP images are allowed."
      )
    );
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

/* =========================
   JWT AUTHENTICATION
========================= */

function authenticateAdmin(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      success: false,
      message: "Authorization token missing.",
    });
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Invalid authorization token.",
    });
  }

  try {
    const decoded = jwt.verify(
      token,
      JWT_SECRET
    );

    req.admin = decoded;

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token.",
    });
  }
}

/* =========================
   BASIC TEST
========================= */

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Shree Photo Studio backend is running.",
  });
});

/* =========================
   CATEGORIES
========================= */

app.get("/api/categories", async (req, res) => {
  try {
    const result = await pool.query(`
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
      categories: result.rows,
    });
  } catch (error) {
    console.error(
      "Categories error:",
      error.message
    );

    res.status(500).json({
      success: false,
      message: "Failed to load categories.",
    });
  }
});

/* =========================
   ENQUIRIES - CREATE
========================= */

app.post("/api/enquiries", async (req, res) => {
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
        message: "Name and mobile are required.",
      });
    }

    const result = await pool.query(
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
      ($1, $2, $3, $4, $5, $6, 'New')
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
      message: "Enquiry submitted successfully.",
      enquiry: result.rows[0],
    });
  } catch (error) {
    console.error(
      "Enquiry create error:",
      error.message
    );

    res.status(500).json({
      success: false,
      message: "Failed to submit enquiry.",
    });
  }
});

/* =========================
   ADMIN LOGIN
========================= */

app.post("/api/admin/login", async (req, res) => {
  try {
    const {
      username,
      password,
    } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message:
          "Username and password are required.",
      });
    }

    const result = await pool.query(
      `
      SELECT *
      FROM admin_users
      WHERE username = $1
      LIMIT 1
      `,
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password.",
      });
    }

    const admin = result.rows[0];

    const passwordMatch =
      await bcrypt.compare(
        password,
        admin.password_hash
      );

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password.",
      });
    }

    const token = jwt.sign(
      {
        id: admin.id,
        username: admin.username,
      },
      JWT_SECRET,
      {
        expiresIn: "2h",
      }
    );

    res.json({
      success: true,
      message: "Login successful.",
      token,
      admin: {
        id: admin.id,
        username: admin.username,
      },
    });
  } catch (error) {
    console.error(
      "Admin login error:",
      error.message
    );

    res.status(500).json({
      success: false,
      message: "Login failed.",
    });
  }
});

/* =========================
   ADMIN ME
========================= */

app.get(
  "/api/admin/me",
  authenticateAdmin,
  async (req, res) => {
    try {
      const result = await pool.query(
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

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Admin not found.",
        });
      }

      res.json({
        success: true,
        admin: result.rows[0],
      });
    } catch (error) {
      console.error(
        "Admin me error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message: "Failed to load admin.",
      });
    }
  }
);

/* =========================
   ENQUIRIES - ADMIN
========================= */

app.get(
  "/api/enquiries",
  authenticateAdmin,
  async (req, res) => {
    try {
      const result = await pool.query(`
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
        enquiries: result.rows,
      });
    } catch (error) {
      console.error(
        "Enquiries error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message: "Failed to load enquiries.",
      });
    }
  }
);

/* =========================
   UPDATE ENQUIRY STATUS
========================= */

app.patch(
  "/api/enquiries/:id/status",
  authenticateAdmin,
  async (req, res) => {
    try {
      const enquiryId = req.params.id;
      const { status } = req.body;

      const allowedStatuses = [
        "New",
        "Contacted",
        "Completed",
      ];

      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid status.",
        });
      }

      const result = await pool.query(
        `
        UPDATE enquiries
        SET status = $1
        WHERE id = $2
        RETURNING *
        `,
        [status, enquiryId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Enquiry not found.",
        });
      }

      res.json({
        success: true,
        message: "Status updated successfully.",
        enquiry: result.rows[0],
      });
    } catch (error) {
      console.error(
        "Status update error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message: "Failed to update status.",
      });
    }
  }
);

/* =========================
   DELETE ENQUIRY
========================= */

app.delete(
  "/api/enquiries/:id",
  authenticateAdmin,
  async (req, res) => {
    try {
      const enquiryId = req.params.id;

      const result = await pool.query(
        `
        DELETE FROM enquiries
        WHERE id = $1
        RETURNING *
        `,
        [enquiryId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Enquiry not found.",
        });
      }

      res.json({
        success: true,
        message: "Enquiry deleted successfully.",
      });
    } catch (error) {
      console.error(
        "Delete enquiry error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message: "Failed to delete enquiry.",
      });
    }
  }
);

/* =========================
   LOGO UPLOAD
========================= */

app.post(
  "/api/admin/upload-logo",
  authenticateAdmin,
  upload.single("logo"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Please select a logo image.",
        });
      }

      const ext = path.extname(
        req.file.originalname
      );

      const newFilename =
        `logo-${Date.now()}${ext}`;

      const oldPath = req.file.path;

      const newPath = path.join(
        uploadsDir,
        newFilename
      );

      fs.renameSync(
        oldPath,
        newPath
      );

      const files = fs.readdirSync(
        uploadsDir
      );

      for (const file of files) {
        if (
          file.startsWith("logo-") &&
          file !== newFilename
        ) {
          try {
            fs.unlinkSync(
              path.join(
                uploadsDir,
                file
              )
            );
          } catch {}
        }
      }

      const imageUrl =
        `/uploads/${newFilename}`;

      res.json({
        success: true,
        message: "Logo uploaded successfully.",
        image_url:
          `http://localhost:${PORT}${imageUrl}`,
      });
    } catch (error) {
      console.error(
        "Logo upload error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message: "Failed to upload logo.",
      });
    }
  }
);

/* =========================
   GET LOGO
========================= */

app.get(
  "/api/admin/logo",
  async (req, res) => {
    try {
      const files = fs
        .readdirSync(uploadsDir)
        .filter((file) =>
          file.startsWith("logo-")
        )
        .sort();

      if (files.length === 0) {
        return res.json({
          success: true,
          logo: null,
        });
      }

      const latestLogo =
        files[files.length - 1];

      res.json({
        success: true,
        logo:
          `http://localhost:${PORT}/uploads/${latestLogo}`,
      });
    } catch (error) {
      console.error(
        "Logo fetch error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message: "Failed to load logo.",
      });
    }
  }
);

/* =========================
   GALLERY - PUBLIC
========================= */

app.get(
  "/api/gallery",
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          id,
          title,
          category,
          image_url,
          created_at
        FROM gallery
        ORDER BY created_at DESC
      `);

      res.json({
        success: true,
        gallery: result.rows,
      });
    } catch (error) {
      console.error(
        "Gallery fetch error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message: "Failed to load gallery.",
      });
    }
  }
);

/* =========================
   GALLERY - UPLOAD
========================= */

app.post(
  "/api/admin/gallery",
  authenticateAdmin,
  upload.single("image"),
  async (req, res) => {
    try {
      const {
        title,
        category,
      } = req.body;

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Please select an image.",
        });
      }

      if (!title || !category) {
        return res.status(400).json({
          success: false,
          message:
            "Title and category are required.",
        });
      }

      const ext = path.extname(
        req.file.originalname
      );

      const filename =
        `gallery-${Date.now()}-${Math.round(
          Math.random() * 1e9
        )}${ext}`;

      const newPath = path.join(
        uploadsDir,
        filename
      );

      fs.renameSync(
        req.file.path,
        newPath
      );

      const imageUrl =
        `/uploads/${filename}`;

      const result = await pool.query(
        `
        INSERT INTO gallery
        (
          title,
          category,
          image_url
        )
        VALUES
        ($1, $2, $3)
        RETURNING *
        `,
        [
          title,
          category,
          imageUrl,
        ]
      );

      res.status(201).json({
        success: true,
        message:
          "Gallery image uploaded successfully.",
        gallery: result.rows[0],
      });
    } catch (error) {
      console.error(
        "Gallery upload error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to upload gallery image.",
      });
    }
  }
);

/* =========================
   GALLERY - DELETE
========================= */

app.delete(
  "/api/admin/gallery/:id",
  authenticateAdmin,
  async (req, res) => {
    try {
      const galleryId =
        req.params.id;

      const result = await pool.query(
        `
        DELETE FROM gallery
        WHERE id = $1
        RETURNING *
        `,
        [galleryId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message:
            "Gallery image not found.",
        });
      }

      const imageUrl =
        result.rows[0].image_url;

      if (imageUrl) {
        const filename =
          path.basename(imageUrl);

        const filePath =
          path.join(
            uploadsDir,
            filename
          );

        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }

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

/* ==================================================
   WEBSITE IMAGES
   HERO / FEATURE / ABOUT
================================================== */

const allowedSiteImageTypes = [
  "hero",
  "feature",
  "about",
];

/* =========================
   GET WEBSITE IMAGES
========================= */

app.get(
  "/api/site-images",
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          image_type,
          image_url,
          updated_at
        FROM site_images
        ORDER BY id ASC
      `);

      const images = {};

      result.rows.forEach((row) => {
        images[row.image_type] =
          `http://localhost:${PORT}${row.image_url}`;
      });

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

/* =========================
   UPLOAD WEBSITE IMAGE
========================= */

app.post(
  "/api/admin/site-images/:type",
  authenticateAdmin,
  upload.single("image"),
  async (req, res) => {
    let newFilePath = null;

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

      const ext = path.extname(
        req.file.originalname
      );

      const filename =
        `site-${imageType}-${Date.now()}${ext}`;

      newFilePath = path.join(
        uploadsDir,
        filename
      );

      fs.renameSync(
        req.file.path,
        newFilePath
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

      const imageUrl =
        `/uploads/${filename}`;

      await pool.query(
        `
        INSERT INTO site_images
        (
          image_type,
          image_url,
          updated_at
        )
        VALUES
        ($1, $2, CURRENT_TIMESTAMP)

        ON CONFLICT (image_type)
        DO UPDATE SET
          image_url = EXCLUDED.image_url,
          updated_at = CURRENT_TIMESTAMP
        `,
        [
          imageType,
          imageUrl,
        ]
      );

      /* Delete previous website image */
      if (
        oldResult.rows.length > 0 &&
        oldResult.rows[0].image_url
      ) {
        const oldFilename =
          path.basename(
            oldResult.rows[0].image_url
          );

        const oldFilePath =
          path.join(
            uploadsDir,
            oldFilename
          );

        if (
          fs.existsSync(oldFilePath)
        ) {
          try {
            fs.unlinkSync(
              oldFilePath
            );
          } catch {}
        }
      }

      res.json({
        success: true,
        message:
          `${imageType} image updated successfully.`,
        image_type: imageType,
        image_url:
          `http://localhost:${PORT}${imageUrl}`,
      });
    } catch (error) {
      console.error(
        "Website image upload error:",
        error.message
      );

      if (
        newFilePath &&
        fs.existsSync(newFilePath)
      ) {
        try {
          fs.unlinkSync(
            newFilePath
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
   MULTER ERROR HANDLER
========================= */

app.use(
  (error, req, res, next) => {
    if (
      error instanceof multer.MulterError
    ) {
      if (
        error.code === "LIMIT_FILE_SIZE"
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Image size must be maximum 5 MB.",
        });
      }

      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    if (error) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    next();
  }
);

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log(
    `Server running at http://localhost:${PORT}`
  );
});