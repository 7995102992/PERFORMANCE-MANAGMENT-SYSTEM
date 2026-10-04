package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsRatingScaleLevelEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface PmsRatingScaleLevelRepository extends JpaRepository<PmsRatingScaleLevelEntity, UUID> {

    List<PmsRatingScaleLevelEntity> findByRatingScaleIdOrderByRatingValueDesc(UUID ratingScaleId);
}
