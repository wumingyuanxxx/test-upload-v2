-- 易绘电商上架工作台
-- MySQL 8.0+ 初始化脚本 | Schema v1.0.0
-- 说明：本脚本只创建不存在的业务库和业务表；不会删除已有数据，也不会创建/修改 MySQL root 账户。

CREATE DATABASE IF NOT EXISTS `yihui-upload-agent`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_0900_ai_ci;

USE `yihui-upload-agent`;

SET NAMES utf8mb4;
-- 本机软件用户。依照当前产品要求，password_value 以明文保存。
CREATE TABLE IF NOT EXISTS `users` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(64) NOT NULL,
  `password_value` VARCHAR(255) NOT NULL,
  `display_name` VARCHAR(128) NULL,
  `status` TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '1=启用，0=停用',
  `last_login_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_username` (`username`)
) ENGINE=InnoDB COMMENT='本地用户';

-- 系统及第三方配置。依照当前产品要求，config_value 可明文保存。
CREATE TABLE IF NOT EXISTS `system_configs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `config_group` VARCHAR(64) NOT NULL COMMENT 'mysql/oss/miaoshou/llm/app',
  `config_key` VARCHAR(128) NOT NULL,
  `config_value` LONGTEXT NULL,
  `value_type` VARCHAR(32) NOT NULL DEFAULT 'string' COMMENT 'string/number/boolean/json',
  `description` VARCHAR(500) NULL,
  `is_enabled` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `updated_by` BIGINT UNSIGNED NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_system_configs_group_key` (`config_group`, `config_key`),
  KEY `idx_system_configs_updated_by` (`updated_by`),
  CONSTRAINT `fk_system_configs_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB COMMENT='本地系统配置';

-- 系统字段值的展示映射，例如 target_platform_code: temu_semi -> TEMU。
CREATE TABLE IF NOT EXISTS `field_mappings` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `mapping_key` VARCHAR(64) NOT NULL COMMENT '需映射的字段名',
  `source_value` VARCHAR(128) NOT NULL COMMENT '原始字段值',
  `display_value` VARCHAR(128) NOT NULL COMMENT '界面展示值',
  `is_enabled` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_field_mappings_key_value` (`mapping_key`, `source_value`),
  KEY `idx_field_mappings_enabled` (`mapping_key`, `is_enabled`, `sort_order`)
) ENGINE=InnoDB COMMENT='字段映射表';

-- 每次导入类目前先创建一个版本，支持回滚与追溯。
CREATE TABLE IF NOT EXISTS `category_versions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `platform_code` VARCHAR(32) NOT NULL COMMENT 'temu_full/temu_semi/tiktok 等',
  `source_name` VARCHAR(64) NOT NULL DEFAULT 'miaoshou',
  `version_no` VARCHAR(64) NOT NULL,
  `source_updated_at` DATETIME NULL,
  `imported_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `is_active` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `import_summary` JSON NULL,
  `created_by` BIGINT UNSIGNED NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_category_versions_platform_version` (`platform_code`, `version_no`),
  KEY `idx_category_versions_active` (`platform_code`, `is_active`),
  CONSTRAINT `fk_category_versions_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB COMMENT='类目导入版本';

CREATE TABLE IF NOT EXISTS `categories` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `category_version_id` BIGINT UNSIGNED NOT NULL,
  `external_category_id` VARCHAR(128) NOT NULL,
  `parent_external_category_id` VARCHAR(128) NULL,
  `category_name` VARCHAR(255) NOT NULL,
  `full_path` VARCHAR(2000) NULL,
  `tree_level` INT UNSIGNED NOT NULL DEFAULT 1,
  `is_leaf` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `status` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `raw_data` JSON NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_categories_version_external` (`category_version_id`, `external_category_id`),
  KEY `idx_categories_parent` (`category_version_id`, `parent_external_category_id`),
  KEY `idx_categories_name` (`category_name`),
  CONSTRAINT `fk_categories_version` FOREIGN KEY (`category_version_id`) REFERENCES `category_versions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='平台类目';

CREATE TABLE IF NOT EXISTS `category_attributes` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `category_id` BIGINT UNSIGNED NOT NULL,
  `external_attribute_id` VARCHAR(128) NOT NULL,
  `attribute_name` VARCHAR(255) NOT NULL,
  `attribute_type` VARCHAR(32) NOT NULL DEFAULT 'text' COMMENT 'text/select/multi_select/number',
  `is_required` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `is_sku_attribute` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `options_data` JSON NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `raw_data` JSON NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_category_attributes_external` (`category_id`, `external_attribute_id`),
  KEY `idx_category_attributes_category` (`category_id`),
  CONSTRAINT `fk_category_attributes_category` FOREIGN KEY (`category_id`) REFERENCES `categories` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='类目属性定义';

-- 智能模板直接保存当前可执行内容，不保留提示词版本。
CREATE TABLE IF NOT EXISTS `templates` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `template_type` VARCHAR(32) NOT NULL COMMENT 'title/image/category/packaging/manual',
  `template_name` VARCHAR(128) NOT NULL,
  `platform_code` VARCHAR(32) NULL,
  `category_external_id` VARCHAR(128) NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'enabled' COMMENT 'enabled/disabled',
  `prompt_content` LONGTEXT NOT NULL,
  `created_by` BIGINT UNSIGNED NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at` DATETIME NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_templates_scope_name` (`template_type`, `platform_code`, `category_external_id`, `template_name`),
  KEY `idx_templates_status` (`template_type`, `status`),
  CONSTRAINT `fk_templates_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB COMMENT='智能模板';

CREATE TABLE IF NOT EXISTS `template_categories` (
  `template_id` BIGINT UNSIGNED NOT NULL,
  `category_id` BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`template_id`, `category_id`),
  KEY `idx_template_categories_category` (`category_id`),
  CONSTRAINT `fk_template_categories_template` FOREIGN KEY (`template_id`) REFERENCES `templates` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_template_categories_category` FOREIGN KEY (`category_id`) REFERENCES `categories` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='智能模板与类目绑定';

CREATE TABLE IF NOT EXISTS `model_providers` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `provider_name` VARCHAR(128) NOT NULL,
  `provider_type` VARCHAR(32) NOT NULL DEFAULT 'openai_compatible',
  `api_base_url` VARCHAR(1000) NULL,
  `api_key_value` TEXT NULL COMMENT '按当前本地明文配置需求保存',
  `default_model` VARCHAR(255) NULL,
  `model_catalog` JSON NULL COMMENT '可用模型列表',
  `timeout_seconds` INT UNSIGNED NOT NULL DEFAULT 300 COMMENT '模型调用超时时间（秒）',
  `image_adapter` VARCHAR(64) NOT NULL DEFAULT 'openai_images_edits' COMMENT '图片模型适配器',
  `image_size` VARCHAR(64) NULL COMMENT '图片模型默认尺寸',
  `remark` VARCHAR(500) NULL,
  `is_enabled` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `is_active` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_model_providers_name` (`provider_name`),
  KEY `idx_model_providers_active` (`is_active`, `is_enabled`, `sort_order`)
) ENGINE=InnoDB COMMENT='大模型供应商配置';

CREATE TABLE IF NOT EXISTS `workflows` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `workflow_name` VARCHAR(128) NOT NULL,
  `platform_code` VARCHAR(32) NULL,
  `category_external_id` VARCHAR(128) NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'enabled' COMMENT 'enabled/disabled',
  `version_no` INT UNSIGNED NOT NULL DEFAULT 1,
  `description` VARCHAR(500) NULL,
  `created_by` BIGINT UNSIGNED NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at` DATETIME NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_workflows_scope_name` (`workflow_name`, `platform_code`, `category_external_id`),
  KEY `idx_workflows_status` (`status`),
  CONSTRAINT `fk_workflows_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB COMMENT='自动化流程';

CREATE TABLE IF NOT EXISTS `workflow_steps` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `workflow_id` BIGINT UNSIGNED NOT NULL,
  `step_order` INT UNSIGNED NOT NULL,
  `step_type` VARCHAR(32) NOT NULL COMMENT 'download_image/process_image/generate_title/fill_attribute/manual_review/write_back',
  `is_enabled` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `template_id` BIGINT UNSIGNED NULL,
  `step_config` JSON NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_workflow_steps_order` (`workflow_id`, `step_order`),
  CONSTRAINT `fk_workflow_steps_workflow` FOREIGN KEY (`workflow_id`) REFERENCES `workflows` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_workflow_steps_template` FOREIGN KEY (`template_id`) REFERENCES `templates` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB COMMENT='自动化流程步骤';

-- 一条产品记录对应一个用户在一个店铺采集箱中的一个商品。
CREATE TABLE IF NOT EXISTS `products` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `source_platform_code` VARCHAR(32) NOT NULL DEFAULT 'miaoshou',
  `source_product_id` VARCHAR(128) NOT NULL,
  `source_store_id` VARCHAR(128) NULL,
  `source_miaoshou_app_id` VARCHAR(128) NULL COMMENT '妙手账号 App ID；文件夹建品草稿为空',
  `copy_origin_product_id` BIGINT UNSIGNED NULL COMMENT '跨店铺复制时的来源商品 ID',
  `source_notes_text` LONGTEXT NULL COMMENT '妙手店铺采集箱详情 notesText，供后续回写使用',
  `source_price` DECIMAL(18,4) NULL COMMENT '妙手货源价格',
  `source_stock` INT NULL COMMENT '妙手货源库存',
  `source_weight` DECIMAL(18,4) NULL COMMENT '妙手货源重量',
  `source_package_length` DECIMAL(18,4) NULL COMMENT '妙手包裹长度',
  `source_package_width` DECIMAL(18,4) NULL COMMENT '妙手包裹宽度',
  `source_package_height` DECIMAL(18,4) NULL COMMENT '妙手包裹高度',
  `source_size_map` JSON NULL COMMENT '妙手尺码映射',
  `source_color_map` JSON NULL COMMENT '妙手颜色映射',
  `target_platform_code` VARCHAR(32) NOT NULL COMMENT 'temu_full/temu_semi',
  `current_category_id` BIGINT UNSIGNED NULL,
  `current_workflow_id` BIGINT UNSIGNED NULL,
  `title` VARCHAR(1000) NOT NULL,
  `generated_title` VARCHAR(1000) NULL COMMENT '本地生成标题，回写妙手时优先替换产品标题',
  `ai_generated_image_urls` JSON NULL COMMENT 'AI 生成图片的 OSS 路径列表',
  `product_status` VARCHAR(32) NOT NULL DEFAULT 'pending_process' COMMENT 'pending_process=商品处理中/image_processing=图片处理中/sku_recognizing=SKU识别中/sku_recognized=SKU识别完成/sku_recognition_failed=SKU识别失败/ready_to_write=可写入/writing/written/failed/archived',
  `source_updated_at` DATETIME NULL,
  `last_synced_at` DATETIME NULL,
  `last_processed_at` DATETIME NULL,
  `last_written_at` DATETIME NULL,
  `last_error_code` VARCHAR(128) NULL,
  `last_error_message` VARCHAR(2000) NULL,
  `raw_data` JSON NULL COMMENT '来源最新原始数据快照，完整历史在 product_source_snapshots',
  `created_by` BIGINT UNSIGNED NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at` DATETIME NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_products_target_collect_box_account_source` (`source_miaoshou_app_id`, `source_platform_code`, `source_product_id`, `source_store_id`, `created_by`),
  UNIQUE KEY `uk_products_store_copy_origin` (`created_by`, `copy_origin_product_id`, `source_miaoshou_app_id`, `source_store_id`),
  KEY `idx_products_list` (`product_status`, `target_platform_code`, `updated_at`),
  KEY `idx_products_category` (`current_category_id`),
  KEY `idx_products_source_updated` (`source_updated_at`),
  CONSTRAINT `fk_products_category` FOREIGN KEY (`current_category_id`) REFERENCES `categories` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_products_workflow` FOREIGN KEY (`current_workflow_id`) REFERENCES `workflows` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_products_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB COMMENT='商品主表';

CREATE TABLE IF NOT EXISTS `product_skus` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `source_sku_id` VARCHAR(128) NULL,
  `sku_code` VARCHAR(255) NULL,
  `sku_name` VARCHAR(500) NULL,
  `attribute_data` JSON NULL,
  `price_amount` DECIMAL(12,2) NULL,
  `currency_code` CHAR(3) NULL,
  `stock_quantity` INT NULL,
  `source_data` JSON NULL,
  `draft_data` JSON NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `is_enabled` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at` DATETIME NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_product_skus_source` (`product_id`, `source_sku_id`),
  KEY `idx_product_skus_product` (`product_id`, `sort_order`),
  CONSTRAINT `fk_product_skus_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='商品 SKU';

CREATE TABLE IF NOT EXISTS `product_source_snapshots` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `snapshot_no` INT UNSIGNED NOT NULL,
  `source_updated_at` DATETIME NULL,
  `payload` JSON NOT NULL,
  `payload_hash` CHAR(64) NOT NULL,
  `synced_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `sync_job_id` BIGINT UNSIGNED NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_product_source_snapshots_no` (`product_id`, `snapshot_no`),
  UNIQUE KEY `uk_product_source_snapshots_hash` (`product_id`, `payload_hash`),
  KEY `idx_product_source_snapshots_synced` (`synced_at`),
  CONSTRAINT `fk_product_source_snapshots_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='来源商品历史快照';

-- 每次用户保存草稿或自动化生成最终可用草稿时生成一个版本；写回任务固定引用此版本。
CREATE TABLE IF NOT EXISTS `product_drafts` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `draft_version_no` INT UNSIGNED NOT NULL,
  `source_snapshot_id` BIGINT UNSIGNED NULL,
  `category_id` BIGINT UNSIGNED NULL,
  `title` VARCHAR(1000) NULL,
  `description_content` LONGTEXT NULL,
  `attribute_data` JSON NULL,
  `sku_data` JSON NULL,
  `validation_status` VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT 'pending/valid/invalid',
  `validation_errors` JSON NULL,
  `review_status` VARCHAR(16) NOT NULL DEFAULT 'draft' COMMENT 'draft/pending_review/approved/rejected',
  `reviewed_by` BIGINT UNSIGNED NULL,
  `reviewed_at` DATETIME NULL,
  `created_by` BIGINT UNSIGNED NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_product_drafts_version` (`product_id`, `draft_version_no`),
  KEY `idx_product_drafts_review` (`review_status`, `updated_at`),
  CONSTRAINT `fk_product_drafts_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_product_drafts_snapshot` FOREIGN KEY (`source_snapshot_id`) REFERENCES `product_source_snapshots` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_product_drafts_category` FOREIGN KEY (`category_id`) REFERENCES `categories` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_product_drafts_reviewed_by` FOREIGN KEY (`reviewed_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_product_drafts_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB COMMENT='商品发布草稿版本';

CREATE TABLE IF NOT EXISTS `assets` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `storage_provider` VARCHAR(32) NOT NULL DEFAULT 'oss',
  `bucket_name` VARCHAR(128) NULL,
  `object_key` VARCHAR(1000) NULL,
  `original_url` VARCHAR(2000) NULL,
  `local_cache_path` VARCHAR(2000) NULL,
  `file_name` VARCHAR(512) NULL,
  `mime_type` VARCHAR(128) NULL,
  `file_size_bytes` BIGINT UNSIGNED NULL,
  `content_hash` CHAR(64) NULL,
  `width_px` INT UNSIGNED NULL,
  `height_px` INT UNSIGNED NULL,
  `asset_kind` VARCHAR(32) NOT NULL COMMENT 'source_image/processed_image/generated_image/manual',
  `parent_asset_id` BIGINT UNSIGNED NULL,
  `process_metadata` JSON NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `deleted_at` DATETIME NULL,
  PRIMARY KEY (`id`),
  KEY `idx_assets_product_kind` (`product_id`, `asset_kind`),
  KEY `idx_assets_content_hash` (`content_hash`),
  KEY `idx_assets_parent` (`parent_asset_id`),
  CONSTRAINT `fk_assets_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_assets_parent` FOREIGN KEY (`parent_asset_id`) REFERENCES `assets` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB COMMENT='素材与图片文件元数据';

CREATE TABLE IF NOT EXISTS `product_images` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `product_sku_id` BIGINT UNSIGNED NULL,
  `asset_id` BIGINT UNSIGNED NOT NULL,
  `image_group` VARCHAR(32) NOT NULL COMMENT 'source/main/detail/sku/generated',
  `sort_order` INT NOT NULL DEFAULT 0,
  `is_selected_for_draft` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_product_images_asset_group` (`product_id`, `asset_id`, `image_group`),
  KEY `idx_product_images_list` (`product_id`, `image_group`, `sort_order`),
  KEY `idx_product_images_sku` (`product_sku_id`),
  CONSTRAINT `fk_product_images_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_product_images_sku` FOREIGN KEY (`product_sku_id`) REFERENCES `product_skus` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_product_images_asset` FOREIGN KEY (`asset_id`) REFERENCES `assets` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB COMMENT='商品图片与素材关联';

-- 持久化队列：同步、下载、图片处理、标题生成、写回均用此表调度。
CREATE TABLE IF NOT EXISTS `jobs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_type` VARCHAR(32) NOT NULL COMMENT 'sync_product/download_asset/process_image/generate_title/validate_draft/write_back/query_publish_status',
  `job_status` VARCHAR(16) NOT NULL DEFAULT 'queued' COMMENT 'queued/running/succeeded/failed/cancelled/dead_letter',
  `product_id` BIGINT UNSIGNED NULL,
  `product_draft_id` BIGINT UNSIGNED NULL,
  `parent_job_id` BIGINT UNSIGNED NULL,
  `idempotency_key` VARCHAR(255) NOT NULL,
  `priority` TINYINT UNSIGNED NOT NULL DEFAULT 5,
  `attempt_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `max_attempts` INT UNSIGNED NOT NULL DEFAULT 3,
  `progress_percent` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `input_payload` JSON NULL COMMENT '包含运行时模板/流程版本快照',
  `output_payload` JSON NULL,
  `error_code` VARCHAR(128) NULL,
  `error_message` VARCHAR(2000) NULL,
  `scheduled_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `started_at` DATETIME NULL,
  `finished_at` DATETIME NULL,
  `created_by` BIGINT UNSIGNED NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_jobs_idempotency` (`idempotency_key`),
  KEY `idx_jobs_scheduler` (`job_status`, `scheduled_at`, `priority`),
  KEY `idx_jobs_product` (`product_id`, `created_at`),
  KEY `idx_jobs_parent` (`parent_job_id`),
  CONSTRAINT `fk_jobs_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_jobs_draft` FOREIGN KEY (`product_draft_id`) REFERENCES `product_drafts` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_jobs_parent` FOREIGN KEY (`parent_job_id`) REFERENCES `jobs` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_jobs_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB COMMENT='异步任务队列';

CREATE TABLE IF NOT EXISTS `job_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_id` BIGINT UNSIGNED NOT NULL,
  `log_level` VARCHAR(16) NOT NULL DEFAULT 'info' COMMENT 'debug/info/warn/error',
  `event_type` VARCHAR(64) NOT NULL,
  `message` VARCHAR(2000) NOT NULL,
  `payload` JSON NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_job_logs_job_time` (`job_id`, `created_at`),
  CONSTRAINT `fk_job_logs_job` FOREIGN KEY (`job_id`) REFERENCES `jobs` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='异步任务日志';

CREATE TABLE IF NOT EXISTS `write_records` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `product_draft_id` BIGINT UNSIGNED NOT NULL,
  `job_id` BIGINT UNSIGNED NULL,
  `target_platform_code` VARCHAR(32) NOT NULL,
  `operation_type` VARCHAR(32) NOT NULL COMMENT 'create/update/publish',
  `record_status` VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT 'pending/running/succeeded/failed',
  `idempotency_key` VARCHAR(255) NOT NULL,
  `external_product_id` VARCHAR(128) NULL,
  `external_request_id` VARCHAR(128) NULL,
  `request_summary` JSON NULL,
  `response_summary` JSON NULL,
  `error_code` VARCHAR(128) NULL,
  `error_message` VARCHAR(2000) NULL,
  `retry_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `created_by` BIGINT UNSIGNED NULL,
  `requested_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `finished_at` DATETIME NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_write_records_idempotency` (`idempotency_key`),
  KEY `idx_write_records_product` (`product_id`, `requested_at`),
  KEY `idx_write_records_status` (`record_status`, `requested_at`),
  KEY `idx_write_records_external_request` (`external_request_id`),
  CONSTRAINT `fk_write_records_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_write_records_draft` FOREIGN KEY (`product_draft_id`) REFERENCES `product_drafts` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_write_records_job` FOREIGN KEY (`job_id`) REFERENCES `jobs` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_write_records_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB COMMENT='写回妙手及发布操作记录';

CREATE TABLE IF NOT EXISTS `miaoshou_write_records` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `product_id` BIGINT UNSIGNED NULL,
  `product_title` VARCHAR(1000) NOT NULL,
  `source_product_id` VARCHAR(128) NOT NULL,
  `platform_code` VARCHAR(64) NULL,
  `site_code` VARCHAR(64) NULL,
  `shop_id` VARCHAR(128) NULL,
  `shop_name` VARCHAR(255) NULL,
  `write_back_status` VARCHAR(32) NOT NULL,
  `record_status` VARCHAR(32) NOT NULL,
  `error_message` VARCHAR(2000) NULL,
  `request_summary` JSON NULL,
  `response_summary` JSON NULL,
  `requested_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `finished_at` DATETIME NULL,
  PRIMARY KEY (`id`),
  KEY `idx_miaoshou_write_records_user_time` (`user_id`, `requested_at`),
  KEY `idx_miaoshou_write_records_status` (`record_status`, `requested_at`),
  CONSTRAINT `fk_miaoshou_write_records_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_miaoshou_write_records_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB COMMENT='妙手店铺采集箱批量回写历史';

CREATE TABLE IF NOT EXISTS `notifications` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `notification_type` VARCHAR(32) NOT NULL COMMENT 'sync_success/process_success/write_success/write_failed/system',
  `title` VARCHAR(255) NOT NULL,
  `content` TEXT NULL,
  `related_product_id` BIGINT UNSIGNED NULL,
  `related_job_id` BIGINT UNSIGNED NULL,
  `is_read` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `read_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_notifications_user_unread` (`user_id`, `is_read`, `created_at`),
  CONSTRAINT `fk_notifications_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_notifications_product` FOREIGN KEY (`related_product_id`) REFERENCES `products` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_notifications_job` FOREIGN KEY (`related_job_id`) REFERENCES `jobs` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB COMMENT='站内通知';

-- 妙手采集箱手动/定时同步的执行记录。
CREATE TABLE IF NOT EXISTS `sync_runs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `trigger_type` VARCHAR(16) NOT NULL COMMENT 'manual/scheduled',
  `status` VARCHAR(16) NOT NULL COMMENT 'running/succeeded/failed/skipped',
  `started_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `finished_at` DATETIME NULL,
  `fetched_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `created_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `updated_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `error_code` VARCHAR(128) NULL,
  `error_message` VARCHAR(2000) NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_sync_runs_status_started` (`status`, `started_at`),
  KEY `idx_sync_runs_trigger_started` (`trigger_type`, `started_at`)
) ENGINE=InnoDB COMMENT='妙手采集箱同步记录';

-- 已授权的妙手店铺。按本机登录用户和妙手 App ID 隔离，避免不同账号或应用混用店铺。
CREATE TABLE IF NOT EXISTS `miaoshou_authorized_shops` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `miaoshou_app_id` VARCHAR(128) NOT NULL,
  `platform_code` VARCHAR(64) NOT NULL,
  `site_code` VARCHAR(64) NOT NULL,
  `shop_id` VARCHAR(128) NOT NULL,
  `shop_name` VARCHAR(255) NOT NULL,
  `shop_mode` VARCHAR(64) NULL,
  `authorization_status` VARCHAR(64) NULL,
  `is_enabled` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `raw_data` JSON NULL,
  `last_synced_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_miaoshou_authorized_shops_identity` (`user_id`, `miaoshou_app_id`, `platform_code`, `site_code`, `shop_id`),
  KEY `idx_miaoshou_authorized_shops_lookup` (`user_id`, `miaoshou_app_id`, `is_enabled`),
  CONSTRAINT `fk_miaoshou_authorized_shops_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='妙手授权店铺本地缓存';

-- 上架自动化的发布目标设置。一个本机用户在一个妙手 App ID 下保留一份当前选择。
CREATE TABLE IF NOT EXISTS `automation_publish_settings` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `miaoshou_app_id` VARCHAR(128) NOT NULL,
  `platform_code` VARCHAR(64) NULL,
  `site_code` VARCHAR(64) NULL,
  `shop_id` VARCHAR(128) NULL,
  `write_target` VARCHAR(64) NOT NULL DEFAULT 'miaoshou_unpublished',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_automation_publish_settings_user_app` (`user_id`, `miaoshou_app_id`),
  CONSTRAINT `fk_automation_publish_settings_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='上架自动化发布目标设置';

-- 上架自动化操作设置。仅按本机用户保存，与妙手 App ID 和发布目标独立。
CREATE TABLE IF NOT EXISTS `automation_operation_settings` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `title_enabled` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `use_miaoshou_category_attributes` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `collect_price_multiplier` DECIMAL(12,4) NOT NULL DEFAULT 1,
  `auto_generate_images` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `prefer_category_image_templates` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `ai_material_planning` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `auto_write_miaoshou` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_automation_operation_settings_user` (`user_id`),
  CONSTRAINT `fk_automation_operation_settings_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='上架自动化操作设置';

-- 自动标题/自动生图与提示词模板、大模型的多对多绑定；仅按本机用户保存。
CREATE TABLE IF NOT EXISTS `automation_operation_bindings` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `operation_type` VARCHAR(32) NOT NULL COMMENT 'title 或 image',
  `binding_type` VARCHAR(32) NOT NULL COMMENT 'template 或 model',
  `target_id` BIGINT UNSIGNED NOT NULL,
  `sort_order` INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_automation_operation_binding` (`user_id`, `operation_type`, `binding_type`, `target_id`),
  KEY `idx_automation_operation_binding_lookup` (`user_id`, `operation_type`, `binding_type`, `sort_order`),
  CONSTRAINT `fk_automation_operation_bindings_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='上架自动化模型与提示词绑定';

-- 本地商品与妙手目标店铺采集箱的对应关系。用于批量回写和后续发布记录追踪。
CREATE TABLE IF NOT EXISTS `miaoshou_product_mappings` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `miaoshou_app_id` VARCHAR(128) NOT NULL,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `source_detail_id` VARCHAR(128) NOT NULL,
  `platform_code` VARCHAR(64) NULL,
  `site_code` VARCHAR(64) NULL,
  `shop_id` VARCHAR(128) NULL,
  `platform_collect_box_detail_id` VARCHAR(128) NULL,
  `write_back_status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `publish_status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `last_error_message` VARCHAR(2000) NULL,
  `request_summary` JSON NULL,
  `response_summary` JSON NULL,
  `last_synced_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_miaoshou_product_mapping` (`user_id`, `miaoshou_app_id`, `product_id`, `platform_code`, `shop_id`),
  KEY `idx_miaoshou_product_mapping_source_detail` (`source_detail_id`),
  CONSTRAINT `fk_miaoshou_product_mappings_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_miaoshou_product_mappings_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='本地商品与妙手采集箱映射';

-- 仅保留本机管理员；其他配置和业务数据由应用运行时创建。
INSERT IGNORE INTO `users` (`username`, `password_value`, `display_name`, `status`)
VALUES ('root', '123456', '本地管理员', 1);

CREATE TABLE IF NOT EXISTS `miaoshou_folder_import_records` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `miaoshou_app_id` VARCHAR(128) NOT NULL,
  `platform_code` VARCHAR(64) NOT NULL,
  `site_code` VARCHAR(64) NULL,
  `shop_id` VARCHAR(128) NOT NULL,
  `common_collect_box_detail_id` BIGINT UNSIGNED NULL,
  `platform_collect_box_detail_id` BIGINT UNSIGNED NULL,
  `import_status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `current_stage` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `error_message` VARCHAR(2000) NULL,
  `create_request` JSON NULL, `create_response` JSON NULL,
  `claim_request` JSON NULL, `claim_response` JSON NULL,
  `write_request` JSON NULL, `write_response` JSON NULL,
  `started_at` DATETIME NULL, `finished_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_miaoshou_folder_import_target` (`user_id`, `product_id`, `miaoshou_app_id`, `platform_code`, `shop_id`),
  KEY `idx_miaoshou_folder_import_status` (`user_id`, `import_status`, `updated_at`),
  CONSTRAINT `fk_miaoshou_folder_import_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_miaoshou_folder_import_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='文件夹建品录入妙手三阶段记录';
