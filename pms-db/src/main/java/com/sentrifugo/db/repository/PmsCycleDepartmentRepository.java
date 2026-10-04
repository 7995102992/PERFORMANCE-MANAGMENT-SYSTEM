package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsCycleDepartmentEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface PmsCycleDepartmentRepository extends JpaRepository<PmsCycleDepartmentEntity, UUID> {

    List<PmsCycleDepartmentEntity> findByCycleId(UUID cycleId);

    void deleteByCycleId(UUID cycleId);
}
