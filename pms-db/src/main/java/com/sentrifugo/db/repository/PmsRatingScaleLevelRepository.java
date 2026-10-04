package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsRatingScaleLevelEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;

public interface PmsRatingScaleLevelRepository extends JpaRepository<PmsRatingScaleLevelEntity, UUID> {
}
