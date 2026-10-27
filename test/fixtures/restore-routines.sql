-- Fixture phục hồi: bảng + dữ liệu ghi trước, sau đó là function SPLIT_STR
-- không khai báo DETERMINISTIC / NO SQL / READS SQL DATA.
-- Trên máy chủ bật log_bin và tắt log_bin_trust_function_creators,
-- CREATE FUNCTION này sẽ thất bại sau khi bảng đã được ghi nếu không preflight.
CREATE TABLE `restore_items` (
  `id` int NOT NULL,
  `name` varchar(100) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO `restore_items` VALUES (1, 'alpha'), (2, 'beta');
DELIMITER ;;
CREATE DEFINER=`root`@`localhost` FUNCTION `SPLIT_STR`(
  input VARCHAR(255),
  delimiter VARCHAR(12),
  part INT
) RETURNS varchar(255) CHARSET utf8mb4
BEGIN
  RETURN REPLACE(
    SUBSTRING(SUBSTRING_INDEX(input, delimiter, part),
      LENGTH(SUBSTRING_INDEX(input, delimiter, part - 1)) + 1),
    delimiter, '');
END;;
DELIMITER ;
