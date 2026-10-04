package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsCycleEligibilityRunEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface PmsCycleEligibilityRunRepository extends JpaRepository<PmsCycleEligibilityRunEntity, UUID> {

    Optional<PmsCycleEligibilityRunEntity> findFirstByCycleIdOrderByStartedOnDesc(UUID cycleId);
}
