package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsCycleEmploymentTypeEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface PmsCycleEmploymentTypeRepository extends JpaRepository<PmsCycleEmploymentTypeEntity, UUID> {

    List<PmsCycleEmploymentTypeEntity> findByCycleId(UUID cycleId);

    void deleteByCycleId(UUID cycleId);
}
