package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsCycleStageEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;

public interface PmsCycleStageRepository extends JpaRepository<PmsCycleStageEntity, UUID> {
}
